package api

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// chargeTab puts `cents` on a credit account: a closed order paid to the tab.
func (fx *fixture) chargeTab(tab uuid.UUID, cents int64) {
	fx.t.Helper()
	o := fx.seedOpenOrder(nil)
	fx.adminExec(`UPDATE orders SET status = 'closed', closed_at = now(), subtotal_cents = $2, total_cents = $2 WHERE id = $1`, o, cents)
	p := fx.seedPayment(o, "house_tab", cents, nil)
	fx.adminExec(`UPDATE payments SET house_tab_id = $2 WHERE id = $1`, p, tab)
}

func (fx *fixture) creditTab(name, phone string) uuid.UUID {
	fx.t.Helper()
	id := fx.seedHouseTab(name, true)
	fx.adminExec(`UPDATE house_tabs SET contact_phone = $2 WHERE id = $1`, id, phone)
	return id
}

func businessCredit(t *testing.T, fx *fixture, q string) businessCreditResp {
	t.Helper()
	var out businessCreditResp
	callHandler(t, fx, GetBusinessCredit(appPool, rbac.NewRepo(nil, nil)), http.MethodGet, "/v1/business/credit", nil, withQuery(q)).
		expectStatus(http.StatusOK).decode(&out)
	return out
}

func creditPair(t *testing.T) (*fixture, *fixture) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Credit Group", a, b)
	joinBranch(t, b, a.User, "owner")
	a.grantFeatures("house_tabs")
	b.grantFeatures("house_tabs")
	return a, b
}

func TestBusinessCredit_LinksTheSamePersonByPhone(t *testing.T) {
	a, b := creditPair(t)
	a.chargeTab(a.creditTab("Ram", "9812345678"), 120000)
	b.chargeTab(b.creditTab("Ram Bahadur", "+977 981-234-5678"), 30000) // same number, other format
	b.chargeTab(b.creditTab("Ram", ""), 5000)                           // no phone: a different Ram, maybe

	got := businessCredit(t, a, "")
	if !got.Complete {
		t.Fatalf("incomplete: %+v", got.Branches)
	}
	if len(got.Customers) != 2 {
		t.Fatalf("customers = %+v; want the linked Ram + the unlinked one", got.Customers)
	}
	linked := got.Customers[0]
	if !linked.Linked || len(linked.Accounts) != 2 || linked.BalanceCents != 150000 {
		t.Fatalf("linked customer = %+v; want 2 accounts, Rs 1,500 owed", linked)
	}
	if got.Customers[1].Linked || got.Customers[1].BalanceCents != 5000 {
		t.Fatalf("a phone-less account was linked: %+v", got.Customers[1])
	}
	assertMoney(t, "total owed", got.TotalOwedCents, 155000)
}

func TestBusinessCredit_PhoneFilterFindsOneCustomer(t *testing.T) {
	a, b := creditPair(t)
	a.chargeTab(a.creditTab("Sita", "9800000001"), 1000)
	b.chargeTab(b.creditTab("Sita", "9800000001"), 2000)
	b.chargeTab(b.creditTab("Hari", "9800000002"), 9999)
	got := businessCredit(t, a, "phone=+9779800000001")
	if len(got.Customers) != 1 || got.Customers[0].BalanceCents != 3000 {
		t.Fatalf("customers = %+v; want only Sita, Rs 30", got.Customers)
	}
}

// A branch where the user can't read credit contributes nothing, and says so.
func TestBusinessCredit_HonoursEachBranchsPermission(t *testing.T) {
	a, b := newTenant(t), newTenant(t)
	rbacSeedSystemRoles(t, a)
	newBusinessOf(t, "Credit Perm", a, b)
	joinBranch(t, b, a.User, "kitchen")
	a.grantFeatures("house_tabs")
	b.grantFeatures("house_tabs")
	b.chargeTab(b.creditTab("Secret", "9811111111"), 7000)
	got := businessCredit(t, a, "")
	if statusOf(got.Branches, b.Slug) != branchDenied || len(got.Customers) != 0 {
		t.Fatalf("branches %+v customers %+v", got.Branches, got.Customers)
	}
}

func TestCreditPhoneKey(t *testing.T) {
	for in, want := range map[string]string{
		"9812345678": "9812345678", "+977 981-234-5678": "9812345678", "9779812345678": "9812345678",
		"01-4412345": "014412345", "": "", "12": "",
	} {
		if got := creditPhoneKey(in); got != want {
			t.Errorf("creditPhoneKey(%q) = %q, want %q", in, got, want)
		}
	}
}
