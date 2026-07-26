package mail

import (
	"strings"
	"testing"
	"time"
)

// When some sales were charged to a house tab, the shift summary must split the
// gross figure into what was actually collected ("Received") vs what's owed on
// credit ("On tab") — so the headline isn't misread as cash in hand.
func TestShiftSummary_SplitsReceivedAndOnTab(t *testing.T) {
	s := ShiftSummary{
		TenantName:    "Sahan",
		Timezone:      "Asia/Kathmandu",
		OpenedAt:      time.Unix(1_700_000_000, 0),
		ClosedAt:      time.Unix(1_700_030_000, 0),
		OrderCount:    3,
		SalesCents:    10000,
		OnTabCents:    4000,
		ReceivedCents: 6000,
	}
	msg := BuildShiftSummaryMessage(s)

	for _, want := range []string{"On tab", "Received"} {
		if !strings.Contains(msg.Text, want) {
			t.Errorf("text summary missing %q", want)
		}
		if !strings.Contains(msg.HTML, want) {
			t.Errorf("html summary missing %q", want)
		}
	}
	// The collected amount should render somewhere (Rs 60.00).
	if !strings.Contains(msg.Text, "Rs 60.00") {
		t.Errorf("text summary missing received amount Rs 60.00:\n%s", msg.Text)
	}
}

// Credit collected during the shift (cash and online) is money against sales
// billed on EARLIER shifts. It must appear in its own block, be labelled as not
// part of this shift's sales, and leave the gross figure alone.
func TestShiftSummary_CreditCollectedBlock(t *testing.T) {
	s := ShiftSummary{
		TenantName:         "Sahan",
		Timezone:           "Asia/Kathmandu",
		OpenedAt:           time.Unix(1_700_000_000, 0),
		ClosedAt:           time.Unix(1_700_030_000, 0),
		OrderCount:         2,
		SalesCents:         8000,
		ReceivedCents:      8000,
		CreditSettledCash:  3000,
		CreditSettledOther: 1500,
	}
	msg := BuildShiftSummaryMessage(s)

	for _, want := range []string{"Credit", "Rs 30.00", "Rs 15.00", "Rs 45.00"} {
		if !strings.Contains(msg.Text, want) {
			t.Errorf("text summary missing %q:\n%s", want, msg.Text)
		}
	}
	if !strings.Contains(msg.Text, "not counted in sales above") {
		t.Errorf("text summary must say credit collected is not part of sales:\n%s", msg.Text)
	}
	if !strings.Contains(msg.HTML, "Credit collected") {
		t.Errorf("html summary missing the credit collected section")
	}
	// Gross sales must be untouched by the collection.
	if !strings.Contains(msg.Text, "Gross sales:   Rs 80.00") {
		t.Errorf("gross sales should stay Rs 80.00:\n%s", msg.Text)
	}
}

// A shift where no tab was paid down shows no credit block at all, so cafes that
// don't run credit see the same email as before.
func TestShiftSummary_NoCreditCollectedHidesBlock(t *testing.T) {
	s := ShiftSummary{
		TenantName: "Sahan",
		Timezone:   "Asia/Kathmandu",
		OpenedAt:   time.Unix(1_700_000_000, 0),
		ClosedAt:   time.Unix(1_700_030_000, 0),
		OrderCount: 1,
		SalesCents: 5000,
	}
	msg := BuildShiftSummaryMessage(s)
	if strings.Contains(msg.Text, "Credit Collected") {
		t.Errorf("text summary should omit the credit block when nothing was collected:\n%s", msg.Text)
	}
	if strings.Contains(msg.HTML, "Credit collected") {
		t.Errorf("html summary should omit the credit section when nothing was collected")
	}
}

// With no on-tab sales the split is suppressed — gross == received, so the
// extra lines would just be noise.
func TestShiftSummary_NoTabHidesSplit(t *testing.T) {
	s := ShiftSummary{
		TenantName:    "Sahan",
		Timezone:      "Asia/Kathmandu",
		OpenedAt:      time.Unix(1_700_000_000, 0),
		ClosedAt:      time.Unix(1_700_030_000, 0),
		OrderCount:    2,
		SalesCents:    8000,
		OnTabCents:    0,
		ReceivedCents: 8000,
	}
	msg := BuildShiftSummaryMessage(s)
	if strings.Contains(msg.Text, "On tab") {
		t.Errorf("text summary should not mention On tab when none was charged:\n%s", msg.Text)
	}
}
