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
