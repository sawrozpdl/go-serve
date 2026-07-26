package e2e

// The edges: races, refusals and boundaries.
//
// Each test here corresponds to a way the books could be corrupted, and most of
// them were reachable before the accuracy audit. They live at the HTTP layer
// because that is where the concurrency is real — two waiters on two tablets are
// two connections, two transactions and two row locks, which a handler test
// calling a function twice in sequence cannot reproduce.

import (
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"
)

// concurrently fires the same request n times at once and returns the status
// codes. Genuine parallelism: every call is its own connection, so the database
// locks are the only thing serialising them.
func (c *cafe) concurrently(n int, client *client, method, path string, body any) []int {
	c.t.Helper()
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		codes []int
		errs  []error
	)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start // line them up so they land together
			code, _, err := client.doQuiet(method, path, body)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
				return
			}
			codes = append(codes, code)
		}()
	}
	close(start)
	wg.Wait()
	for _, err := range errs {
		c.t.Fatalf("concurrent %s %s: %v", method, path, err)
	}
	return codes
}

func countCode(codes []int, want int) int {
	n := 0
	for _, c := range codes {
		if c == want {
			n++
		}
	}
	return n
}

// =========================================================================
// Races
// =========================================================================

// Two tablets settling the same tab at once. Before the FOR UPDATE fix both
// reads saw a full balance, both payments were accepted, and the order could
// then never be closed (payments != total) — money on the books twice.
func TestRace_OrderCannotBeOverpaidByConcurrentSettles(t *testing.T) {
	c := newCafe(t)
	c.openShift(100000)
	order := c.openOrder()
	c.addItem(order, c.Coffee, 1)
	q := c.quote(order)

	codes := c.concurrently(4, c.Manager, http.MethodPost,
		"/v1/orders/"+order+"/payments",
		map[string]any{"method": "cash", "amount_cents": q.TotalCents})

	if got := countCode(codes, http.StatusCreated); got != 1 {
		t.Fatalf("%d of 4 concurrent full settles were accepted, want exactly 1 (codes %v)", got, codes)
	}
	after := c.quote(order)
	assertMoney(t, "paid after the race", after.PaidCents, q.TotalCents)
	assertMoney(t, "balance after the race", after.BalanceCents, 0)

	// And the order still closes, which is the practical consequence.
	c.closeOrder(order)
	c.assertClean()
}

// Two collections against one credit account, each for the whole balance. The
// tab must never go negative — that is a customer being charged money they don't
// owe, and it is the invariant `negative_tab` watches for in production.
func TestRace_CreditAccountCannotBeCollectedTwice(t *testing.T) {
	c := newCafe(t)
	c.openShift(100000)
	tab := c.creditAccount("Race Tab")

	order := c.openOrder()
	c.addItem(order, c.Coffee, 2)
	q := c.quote(order)
	c.pay(order, "house_tab", q.TotalCents, tab)
	c.closeOrder(order)

	codes := c.concurrently(4, c.Manager, http.MethodPost,
		"/v1/house-tabs/"+tab+"/settlements",
		map[string]any{"amount_cents": q.TotalCents, "payment_method": "cash"})

	if got := countCode(codes, http.StatusCreated); got != 1 {
		t.Fatalf("%d of 4 concurrent full collections were accepted, want exactly 1 (codes %v)",
			got, codes)
	}
	bal := c.Owner.get("/v1/house-tabs/" + tab).expect(http.StatusOK).money("house_tab.balance_cents")
	if bal < 0 {
		t.Fatalf("credit balance went negative (%d) — the customer was over-collected", bal)
	}
	assertMoney(t, "credit balance after the race", bal, 0)
	c.assertClean()
}

// Only one shift may be open per cafe. Two tills opening at once must not both
// win, or every cash figure afterwards is split across two drawers.
func TestRace_OnlyOneShiftOpensAtATime(t *testing.T) {
	c := newCafe(t)
	codes := c.concurrently(4, c.Manager, http.MethodPost, "/v1/shifts/open",
		map[string]any{"opening_float_cents": 100000})
	if got := countCode(codes, http.StatusCreated); got != 1 {
		t.Fatalf("%d of 4 concurrent shift opens were accepted, want exactly 1 (codes %v)", got, codes)
	}
}

// =========================================================================
// Refusals that protect closed books
// =========================================================================

// A line voided after the order closed permanently desyncs the frozen totals
// from the lines behind them. The API must refuse; if it ever stops refusing,
// the accuracy checker's post_close_void rule starts firing on live data.
func TestClosedBooks_VoidingALineAfterCloseIsRefused(t *testing.T) {
	c := newCafe(t)
	c.openShift(100000)
	order := c.openOrder()
	c.addItem(order, c.Coffee, 2)

	var items struct {
		Items []struct{ ID string } `json:"items"`
	}
	c.Waiter.get("/v1/orders/" + order).expect(http.StatusOK).decode(&items)
	if len(items.Items) == 0 {
		t.Fatal("order has no items to void")
	}
	line := items.Items[0].ID

	q := c.quote(order)
	c.pay(order, "cash", q.TotalCents, "")
	c.closeOrder(order)

	got := c.Manager.post("/v1/orders/"+order+"/items/"+line+"/void",
		map[string]any{"reason": "too late"})
	if got.Code != http.StatusConflict {
		t.Fatalf("voiding a line on a closed order = %d, want 409; body: %s", got.Code, got.Body)
	}
	// Totals untouched.
	assertMoney(t, "sales after the refused void",
		c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK).
			money("kpis.sales_cents"), q.TotalCents)
	c.assertClean()
}

// Cancelling an order that already took money would leave cash in the drawer
// with no sale behind it, forever.
func TestClosedBooks_CancellingAnOrderWithPaymentsIsRefused(t *testing.T) {
	c := newCafe(t)
	c.openShift(100000)
	order := c.openOrder()
	c.addItem(order, c.Cake, 1)
	q := c.quote(order)
	c.pay(order, "cash", q.TotalCents, "")

	got := c.Manager.post("/v1/orders/"+order+"/cancel", map[string]any{"reason": "changed mind"})
	if got.Code != http.StatusConflict {
		t.Fatalf("cancelling a paid order = %d, want 409; body: %s", got.Code, got.Body)
	}
	c.closeOrder(order)
	c.assertClean()
}

// Deleting a cash payment out of a CLOSED shift silently invalidates the
// variance that was signed off on. Refuse it; the correction path is a reversal
// on an open shift, not editing history.
func TestClosedBooks_DeletingAPaymentFromAClosedShiftIsRefused(t *testing.T) {
	c := newCafe(t)
	shift := c.openShift(100000)
	order := c.openOrder()
	c.addItem(order, c.Coffee, 1)
	q := c.quote(order)
	c.pay(order, "cash", q.TotalCents, "")
	c.closeOrder(order)

	var pays struct {
		Payments []struct{ ID string } `json:"payments"`
	}
	c.Manager.get("/v1/orders/" + order + "/payments").expect(http.StatusOK).decode(&pays)
	if len(pays.Payments) != 1 {
		t.Fatalf("expected 1 payment, got %d", len(pays.Payments))
	}

	c.Manager.post("/v1/shifts/"+shift+"/close",
		map[string]any{"closing_count_cents": 100000 + q.TotalCents}).expect(http.StatusOK)

	got := c.Manager.del("/v1/orders/" + order + "/payments/" + pays.Payments[0].ID)
	if got.Code != http.StatusConflict {
		t.Fatalf("deleting a payment from a closed shift = %d, want 409; body: %s", got.Code, got.Body)
	}
	c.assertClean()
}

// A reversal is the correction path, so it must itself be safe: reasons are
// mandatory (the audit trail has to answer "why") and a reversal cannot be
// applied twice, which would credit the tab back twice.
func TestClosedBooks_ReversalNeedsAReasonAndHappensOnce(t *testing.T) {
	c := newCafe(t)
	c.openShift(100000)
	tab := c.creditAccount("Reversible")
	order := c.openOrder()
	c.addItem(order, c.Coffee, 1)
	q := c.quote(order)
	c.pay(order, "house_tab", q.TotalCents, tab)
	c.closeOrder(order)

	var set struct{ ID string }
	c.Manager.post("/v1/house-tabs/"+tab+"/settlements",
		map[string]any{"amount_cents": q.TotalCents, "payment_method": "cash"}).
		expect(http.StatusCreated).decode(&set)

	reverse := "/v1/house-tabs/" + tab + "/settlements/" + set.ID + "/reverse"
	c.Manager.post(reverse, map[string]any{}).expect(http.StatusBadRequest)
	c.Manager.post(reverse, map[string]any{"reason": "wrong tab"}).expect(http.StatusOK)

	// Second attempt must not credit the tab again.
	again := c.Manager.post(reverse, map[string]any{"reason": "again"})
	if again.Code == http.StatusOK {
		t.Fatal("a settlement was reversed twice — the credit balance would be restored twice")
	}
	assertMoney(t, "credit balance after one reversal",
		c.Owner.get("/v1/house-tabs/"+tab).expect(http.StatusOK).money("house_tab.balance_cents"),
		q.TotalCents)
	c.assertClean()
}

// Two reversals racing on the same row must behave the same way.
func TestRace_ASettlementIsReversedAtMostOnce(t *testing.T) {
	c := newCafe(t)
	c.openShift(100000)
	tab := c.creditAccount("Race Reversal")
	order := c.openOrder()
	c.addItem(order, c.Coffee, 2)
	q := c.quote(order)
	c.pay(order, "house_tab", q.TotalCents, tab)
	c.closeOrder(order)

	var set struct{ ID string }
	c.Manager.post("/v1/house-tabs/"+tab+"/settlements",
		map[string]any{"amount_cents": q.TotalCents, "payment_method": "cash"}).
		expect(http.StatusCreated).decode(&set)

	codes := c.concurrently(4, c.Manager, http.MethodPost,
		"/v1/house-tabs/"+tab+"/settlements/"+set.ID+"/reverse",
		map[string]any{"reason": "race"})
	if got := countCode(codes, http.StatusOK); got != 1 {
		t.Fatalf("%d of 4 concurrent reversals succeeded, want exactly 1 (codes %v)", got, codes)
	}
	assertMoney(t, "credit balance after the reversal race",
		c.Owner.get("/v1/house-tabs/"+tab).expect(http.StatusOK).money("house_tab.balance_cents"),
		q.TotalCents)
	c.assertClean()
}

// =========================================================================
// Input boundaries
// =========================================================================

func TestBoundary_RefusedInputs(t *testing.T) {
	c := newCafe(t)
	c.openShift(100000)

	t.Run("empty order cannot be closed", func(t *testing.T) {
		empty := c.openOrder()
		got := c.Manager.post("/v1/orders/"+empty+"/close", nil)
		if got.Code == http.StatusOK {
			t.Fatal("an order with no items closed as a sale")
		}
		c.Manager.post("/v1/orders/"+empty+"/cancel", map[string]any{"reason": "cleanup"}).
			expect(http.StatusNoContent)
	})

	t.Run("overpayment is refused", func(t *testing.T) {
		order := c.openOrder()
		c.addItem(order, c.Cake, 1)
		q := c.quote(order)
		got := c.Manager.post("/v1/orders/"+order+"/payments",
			map[string]any{"method": "cash", "amount_cents": q.TotalCents + 1})
		if got.Code == http.StatusCreated {
			t.Fatal("a payment larger than the balance was accepted")
		}
		c.pay(order, "cash", q.TotalCents, "")
		c.closeOrder(order)
	})

	t.Run("credit payment without an account is refused", func(t *testing.T) {
		order := c.openOrder()
		c.addItem(order, c.Cake, 1)
		q := c.quote(order)
		got := c.Manager.post("/v1/orders/"+order+"/payments",
			map[string]any{"method": "house_tab", "amount_cents": q.TotalCents})
		if got.Code == http.StatusCreated {
			t.Fatal("a credit charge with no credit account was accepted — a receivable owned by nobody")
		}
		c.pay(order, "cash", q.TotalCents, "")
		c.closeOrder(order)
	})

	t.Run("bank is not a customer payment channel", func(t *testing.T) {
		order := c.openOrder()
		c.addItem(order, c.Cake, 1)
		q := c.quote(order)
		c.Manager.post("/v1/orders/"+order+"/payments",
			map[string]any{"method": "bank", "amount_cents": q.TotalCents}).
			expect(http.StatusBadRequest)
		c.pay(order, "cash", q.TotalCents, "")
		c.closeOrder(order)
	})

	t.Run("a transfer fee cannot swallow the transfer", func(t *testing.T) {
		c.Manager.post("/v1/transfers", map[string]any{
			"from_method": "cash", "to_method": "bank",
			"amount_cents": 1000, "fee_cents": 1000,
		}).expect(http.StatusBadRequest)
	})

	t.Run("a discount cannot exceed what is being discounted", func(t *testing.T) {
		order := c.openOrder()
		c.addItem(order, c.Cake, 1) // 6,000 + 600 service
		got := c.Manager.post("/v1/orders/"+order+"/adjustments", map[string]any{
			"type": "discount", "amount_cents": 100000, "reason": "typo",
		})
		if got.Code == http.StatusCreated {
			q := c.quote(order)
			// If it is allowed at all, the stored order must still reconcile:
			// subtotal − discount + service (+ VAT) == total, never negative.
			if q.TotalCents < 0 {
				t.Fatalf("an over-discount produced a negative total (%d)", q.TotalCents)
			}
			if q.SubtotalCents-q.DiscountCents+q.ServiceChargeCents+q.TaxCents != q.TotalCents {
				t.Fatalf("an over-discount broke the receipt: %d − %d + %d + %d != %d",
					q.SubtotalCents, q.DiscountCents, q.ServiceChargeCents, q.TaxCents, q.TotalCents)
			}
		}
		c.Manager.post("/v1/orders/"+order+"/cancel", map[string]any{"reason": "cleanup"}).
			expect(http.StatusNoContent)
	})

	t.Run("negative and absurd amounts are refused", func(t *testing.T) {
		order := c.openOrder()
		c.addItem(order, c.Cake, 1)
		for _, amount := range []int64{0, -1, -100000} {
			c.Manager.post("/v1/orders/"+order+"/payments",
				map[string]any{"method": "cash", "amount_cents": amount}).
				expect(http.StatusBadRequest)
		}
		c.Manager.post("/v1/orders/"+order+"/cancel", map[string]any{"reason": "cleanup"}).
			expect(http.StatusNoContent)
	})

	c.assertClean()
}

// =========================================================================
// Day boundaries
//
// Reports window on tenant-local days, half-open [from, to). An order closed one
// second before local midnight belongs to the day that is ending; one closed at
// midnight exactly belongs to the day beginning. Getting this wrong moves money
// between days, which is how a "missing" day's takings gets reported.
// =========================================================================

func TestBoundary_MidnightBelongsToTheDayThatIsBeginning(t *testing.T) {
	c := newCafe(t)
	c.openShift(100000)

	// Two orders, backdated to either side of local midnight. closed_at is set
	// with the admin pool because the API (correctly) stamps it itself.
	mk := func(item string, qty float64) (string, int64) {
		order := c.openOrder()
		c.addItem(order, item, qty)
		q := c.quote(order)
		c.pay(order, "cash", q.TotalCents, "")
		c.closeOrder(order)
		return order, q.TotalCents
	}
	lateYesterday, lateTotal := mk(c.Coffee, 1)
	earlyToday, earlyTotal := mk(c.Cake, 1)

	// 23:59:59 yesterday, and 00:00:00 today — both in the cafe's timezone.
	c.exec(`
		UPDATE orders
		SET closed_at = ((now() AT TIME ZONE 'Asia/Kathmandu')::date - interval '1 second')
		                AT TIME ZONE 'Asia/Kathmandu'
		WHERE id = $1
	`, lateYesterday)
	c.exec(`
		UPDATE orders
		SET closed_at = (now() AT TIME ZONE 'Asia/Kathmandu')::date AT TIME ZONE 'Asia/Kathmandu'
		WHERE id = $1
	`, earlyToday)

	today := localDay(t, time.Now())
	yesterday := localDay(t, time.Now().AddDate(0, 0, -1))

	assertMoney(t, "today's sales (the midnight order, and only it)",
		c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK).
			money("kpis.sales_cents"), earlyTotal)

	assertMoney(t, "yesterday's sales (the 23:59:59 order)",
		c.Owner.get(fmt.Sprintf("/v1/reports/dashboard?from=%s&to=%s", yesterday, yesterday)).
			expect(http.StatusOK).money("kpis.sales_cents"), lateTotal)

	// History must agree with the KPI window, day for day.
	dayTotal := func(date string) int64 {
		var body struct {
			Orders []struct {
				TotalCents int64 `json:"total_cents"`
			} `json:"orders"`
		}
		c.Owner.get("/v1/orders/history?date=" + date).expect(http.StatusOK).decode(&body)
		var sum int64
		for _, o := range body.Orders {
			sum += o.TotalCents
		}
		return sum
	}
	assertMoney(t, "history for today", dayTotal(today), earlyTotal)
	assertMoney(t, "history for yesterday", dayTotal(yesterday), lateTotal)

	c.assertClean()
}

// A cafe in a different timezone must window on ITS midnight, not the server's.
// Kathmandu is UTC+5:45 and Honolulu UTC−10:00, so an order timestamped now is
// on different local days in the two — which is exactly the bug that a
// server-timezone window hides in development and produces in production.
func TestBoundary_WindowsFollowTheCafeTimezone(t *testing.T) {
	c := newCafe(t)
	c.exec(`UPDATE tenants SET timezone = 'Pacific/Honolulu' WHERE id = $1`, c.TenantID)
	c.openShift(100000)

	order := c.openOrder()
	c.addItem(order, c.Coffee, 1)
	q := c.quote(order)
	c.pay(order, "cash", q.TotalCents, "")
	c.closeOrder(order)

	dash := c.Owner.get("/v1/reports/dashboard?range=today").expect(http.StatusOK)
	if tz, _ := dash.json()["timezone"].(string); tz != "Pacific/Honolulu" {
		t.Fatalf("dashboard timezone = %q, want Pacific/Honolulu", tz)
	}
	assertMoney(t, "today's sales in the cafe's own timezone",
		dash.money("kpis.sales_cents"), q.TotalCents)

	// The cafe-local day, whatever it is there, must list the order.
	loc, err := time.LoadLocation("Pacific/Honolulu")
	if err != nil {
		t.Fatalf("load tz: %v", err)
	}
	var body struct {
		Orders []struct {
			TotalCents int64 `json:"total_cents"`
		} `json:"orders"`
	}
	c.Owner.get("/v1/orders/history?date=" + time.Now().In(loc).Format("2006-01-02")).
		expect(http.StatusOK).decode(&body)
	var sum int64
	for _, o := range body.Orders {
		sum += o.TotalCents
	}
	assertMoney(t, "history in the cafe's own timezone", sum, q.TotalCents)

	c.assertClean()
}

// =========================================================================
// Replay safety
//
// Tablets retry. A retried write must not double-charge.
// =========================================================================

func TestReplay_RetryingAVoidIsHarmless(t *testing.T) {
	c := newCafe(t)
	c.openShift(100000)
	order := c.openOrder()
	c.addItem(order, c.Coffee, 2)

	var items struct {
		Items []struct{ ID string } `json:"items"`
	}
	c.Waiter.get("/v1/orders/" + order).expect(http.StatusOK).decode(&items)
	line := items.Items[0].ID

	before := c.quote(order)
	path := "/v1/orders/" + order + "/items/" + line + "/void"
	c.Manager.post(path, map[string]any{"reason": "spilled"}).expect(http.StatusNoContent)
	after := c.quote(order)
	if after.SubtotalCents >= before.SubtotalCents {
		t.Fatalf("voiding a line did not reduce the subtotal (%d → %d)",
			before.SubtotalCents, after.SubtotalCents)
	}

	// The retry: same call again must be a no-op, not a second reduction.
	c.Manager.post(path, map[string]any{"reason": "spilled"}).expect(http.StatusNoContent)
	assertMoney(t, "subtotal after a retried void", c.quote(order).SubtotalCents, after.SubtotalCents)

	c.Manager.post("/v1/orders/"+order+"/cancel", map[string]any{"reason": "cleanup"}).
		expect(http.StatusNoContent)
	c.assertClean()
}
