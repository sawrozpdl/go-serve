package api

// The item name on an order line is a SNAPSHOT (migration 0080), like the price
// and the cost beside it. Renaming a menu item must not rewrite bills that were
// already printed and handed to a customer.
//
// The other half of the contract matters just as much: item-scoped reports keep
// joining menu_items, because a renamed item is still ONE item and reading the
// snapshot there would split it into a row per historical name.

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// nameSnapshotWorld: one closed, paid order for "Latte", ready to be renamed.
type nameSnapshotWorld struct {
	fx    *fixture
	order uuid.UUID
	item  uuid.UUID
	day   string
}

func seedNameSnapshotWorld(t *testing.T) *nameSnapshotWorld {
	t.Helper()
	fx := newTenant(t)
	fx.grantRole(fx.User, "owner")
	at := pastUTC(3)

	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Latte", 15000)
	order := fx.seedOpenOrder(nil)
	fx.seedOrderItem(order, item, 2, 15000)
	fx.closeOrderPaidInFull(order)
	fx.adminExec(`UPDATE orders SET closed_at = $2 WHERE id = $1`, order, at)

	return &nameSnapshotWorld{fx: fx, order: order, item: item, day: localDay(t, at)}
}

func (w *nameSnapshotWorld) rename(to string) {
	w.fx.adminExec(`UPDATE menu_items SET name = $2 WHERE id = $1`, w.item, to)
}

// The line's own column is frozen at add time.
func TestOrderItemName_SnapshotSurvivesARename(t *testing.T) {
	w := seedNameSnapshotWorld(t)

	var stored string
	w.fx.adminScan([]any{&stored},
		`SELECT menu_item_name FROM order_items WHERE order_id = $1`, w.order)
	if stored != "Latte" {
		t.Fatalf("snapshot = %q, want %q", stored, "Latte")
	}

	w.rename("Cafe Latte Grande")

	w.fx.adminScan([]any{&stored},
		`SELECT menu_item_name FROM order_items WHERE order_id = $1`, w.order)
	if stored != "Latte" {
		t.Errorf("snapshot = %q after a rename, want %q — a settled bill was rewritten", stored, "Latte")
	}
}

// GET /v1/orders/{id} — the read that feeds the tab UI, the settle screen and
// every receipt/KOT print.
func TestOrderItemName_GetOrderReportsTheNameAsSold(t *testing.T) {
	w := seedNameSnapshotWorld(t)
	w.rename("Cafe Latte Grande")

	var got Order
	callHandler(t, w.fx, GetOrder, http.MethodGet, "/orders/x", nil,
		withParam("id", w.order.String())).expectStatus(http.StatusOK).decode(&got)

	if len(got.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(got.Items))
	}
	if got.Items[0].MenuItemName != "Latte" {
		t.Errorf("GetOrder item name = %q, want %q (the name the customer was charged for)",
			got.Items[0].MenuItemName, "Latte")
	}
}

// GET /v1/orders/history — THE historical-receipt read. Feeds the history page,
// receipt reprints, the PDF voids table and the MCP tool.
func TestOrderItemName_HistoryReportsTheNameAsSold(t *testing.T) {
	w := seedNameSnapshotWorld(t)
	w.rename("Cafe Latte Grande")

	var got struct {
		Orders []struct {
			ID    uuid.UUID `json:"id"`
			Items []struct {
				MenuItemName string `json:"menu_item_name"`
			} `json:"items"`
		} `json:"orders"`
	}
	callHandler(t, w.fx, GetOrderHistory, http.MethodGet, "/orders/history", nil,
		withQuery("range=custom&from="+w.day+"&to="+w.day)).expectStatus(http.StatusOK).decode(&got)

	var seen []string
	for _, o := range got.Orders {
		if o.ID != w.order {
			continue
		}
		for _, it := range o.Items {
			seen = append(seen, it.MenuItemName)
		}
	}
	if len(seen) != 1 || seen[0] != "Latte" {
		t.Errorf("history item names = %v, want [Latte] — a reprint of a settled bill "+
			"must not show a name the customer never saw", seen)
	}
}

// GET /v1/kitchen/tickets — a rename mid-service must not make the KDS disagree
// with the docket already on the pass.
func TestOrderItemName_KitchenTicketReportsTheNameAsSold(t *testing.T) {
	fx := newTenant(t)
	fx.grantRole(fx.User, "owner")
	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Latte", 15000)
	order := fx.seedOpenOrder(nil)
	line := fx.seedOrderItem(order, item, 1, 15000)
	fx.adminExec(`UPDATE order_items SET kitchen_status = 'in_progress', sent_to_kitchen_at = now() WHERE id = $1`, line)

	fx.adminExec(`UPDATE menu_items SET name = $2 WHERE id = $1`, item, "Cafe Latte Grande")

	var got struct {
		Tickets []struct {
			MenuItemName string `json:"menu_item_name"`
		} `json:"tickets"`
	}
	callHandler(t, fx, ListKitchenTickets, http.MethodGet, "/kitchen/tickets", nil).
		expectStatus(http.StatusOK).decode(&got)

	if len(got.Tickets) != 1 {
		t.Fatalf("tickets = %d, want 1", len(got.Tickets))
	}
	if got.Tickets[0].MenuItemName != "Latte" {
		t.Errorf("kitchen ticket name = %q, want %q (matching the printed docket)",
			got.Tickets[0].MenuItemName, "Latte")
	}
}

// The trigger is what makes the snapshot true for EVERY writer — the demo seed,
// the six direct INSERTs in this suite, and whatever writes lines next. It is
// also what keeps the currently-deployed binary working during the window
// between migrations running and the new code rolling out.
func TestOrderItemName_TriggerFillsAnInsertThatOmitsTheColumn(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Latte", 15000)
	order := fx.seedOpenOrder(nil)

	// Exactly what the old binary's INSERT looks like: no menu_item_name.
	if err := fx.appTx(func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `
			INSERT INTO order_items (tenant_id, order_id, menu_item_id, qty, unit_price_cents)
			VALUES ($1, $2, $3, 1, 15000)`, fx.Tenant, order, item)
		if err != nil {
			return err
		}
		var got string
		if err := tx.QueryRow(context.Background(),
			`SELECT menu_item_name FROM order_items WHERE order_id = $1`, order).Scan(&got); err != nil {
			return err
		}
		if got != "Latte" {
			t.Errorf("trigger left %q, want %q", got, "Latte")
		}
		return nil
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

// An explicit value always wins over the trigger — otherwise a line could never
// record a name that differs from the catalog's current one.
func TestOrderItemName_ExplicitValueBeatsTheTrigger(t *testing.T) {
	fx := newTenant(t)
	cat := fx.seedCategory("Drinks")
	item := fx.seedMenuItem(cat, "Latte", 15000)
	order := fx.seedOpenOrder(nil)

	if err := fx.appTx(func(tx pgx.Tx) error {
		var got string
		return tx.QueryRow(context.Background(), `
			INSERT INTO order_items (tenant_id, order_id, menu_item_id, menu_item_name, qty, unit_price_cents)
			VALUES ($1, $2, $3, 'Latte (old menu)', 1, 15000)
			RETURNING menu_item_name`, fx.Tenant, order, item).Scan(&got)
	}); err != nil {
		t.Fatalf("appTx: %v", err)
	}
}

// The other half of the contract. Item-scoped reports MUST keep the live name:
// a renamed item is one item, and grouping by the snapshot would report it as
// two different products that each sold half as much.
func TestOrderItemName_ItemReportsUseTheCurrentName(t *testing.T) {
	w := seedNameSnapshotWorld(t)
	w.rename("Cafe Latte Grande")

	var movers MoversResp
	callHandler(t, w.fx, GetMovers, http.MethodGet, "/reports/movers", nil,
		withQuery("range=custom&from="+w.day+"&to="+w.day)).expectStatus(http.StatusOK).decode(&movers)

	if len(movers.Rows) != 1 {
		t.Fatalf("mover rows = %d, want 1 — a rename must not split one item into two", len(movers.Rows))
	}
	if movers.Rows[0].Name != "Cafe Latte Grande" {
		t.Errorf("mover row name = %q, want %q — an item report answers "+
			"\"how is this item selling\", so it shows the name in the menu editor today",
			movers.Rows[0].Name, "Cafe Latte Grande")
	}
}
