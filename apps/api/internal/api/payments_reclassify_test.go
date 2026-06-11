package api

import "testing"

func TestPaymentClass(t *testing.T) {
	tests := []struct {
		method string
		want   string
	}{
		{"cash", "cash"},
		{"house_tab", "house_tab"},
		// All digital channels bucket as "online": 'online' from the 0015
		// backfill, 'other' from current RecordPayment writes, and the
		// historical per-wallet values.
		{"online", "online"},
		{"other", "online"},
		{"esewa", "online"},
		{"khalti", "online"},
		{"card", "online"},
		// 'bank' never appears in payments (RecordPayment rejects it), but
		// the bucketing should still be non-cash if it ever did.
		{"bank", "online"},
	}
	for _, tc := range tests {
		t.Run(tc.method, func(t *testing.T) {
			if got := paymentClass(tc.method); got != tc.want {
				t.Errorf("paymentClass(%q) = %q, want %q", tc.method, got, tc.want)
			}
		})
	}
}
