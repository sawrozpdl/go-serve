package billread

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// A manual, opt-in probe against the REAL provider. Skipped unless
// BILLREAD_LIVE_SA and BILLREAD_LIVE_BILL are set, so `go test ./...` never
// spends money or needs a network. It exists because the one thing the mocked
// tests cannot prove is that a real model, on a real image, over the real wire,
// produces something this package's verifier accepts.
func TestLive_ReadARealBill(t *testing.T) {
	saPath := os.Getenv("BILLREAD_LIVE_SA")
	billPath := os.Getenv("BILLREAD_LIVE_BILL")
	project := os.Getenv("BILLREAD_LIVE_PROJECT")
	if saPath == "" || billPath == "" || project == "" {
		t.Skip("set BILLREAD_LIVE_SA, BILLREAD_LIVE_BILL and BILLREAD_LIVE_PROJECT to run")
	}
	sa, err := os.ReadFile(saPath)
	if err != nil {
		t.Fatal(err)
	}
	img, err := os.ReadFile(billPath)
	if err != nil {
		t.Fatal(err)
	}
	c := New(Config{VertexProject: project, ServiceAccountJSON: string(sa)})
	if !c.Enabled() {
		t.Fatal("client disabled")
	}
	t.Logf("provider=%s model=%s", c.Provider(), c.Model())

	loc, _ := time.LoadLocation("Asia/Kathmandu")
	s, err := c.Extract(t.Context(), Bill{
		Data: img, MimeType: "image/png", TZ: "Asia/Kathmandu",
		Today: time.Date(2026, 9, 15, 12, 0, 0, 0, loc),
	})
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	t.Logf("suggestion:\n%s", b)
	t.Logf("tokens in=%d out=%d cost_micros=%d",
		s.Usage.InputTokens, s.Usage.OutputTokens, s.Usage.CostMicros)
	if len(s.Fields) == 0 {
		t.Fatal("nothing survived verification on a legible bill")
	}
}
