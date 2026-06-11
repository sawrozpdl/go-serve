package api

import (
	"strings"
	"testing"
	"time"
)

func TestExpenseDiffClauses(t *testing.T) {
	base := expenseFields{
		Vendor:       "Local Mill",
		AmountCents:  500000,
		CategoryName: "Supplies",
		PaidAt:       time.Date(2026, 6, 1, 10, 30, 0, 0, time.UTC),
		ReferenceNo:  "INV-42",
		Notes:        "weekly flour",
	}

	tests := []struct {
		name string
		new  func(expenseFields) expenseFields
		want []string // substrings expected in the joined clauses, in order
	}{
		{
			name: "no changes",
			new:  func(f expenseFields) expenseFields { return f },
			want: nil,
		},
		{
			name: "amount only",
			new: func(f expenseFields) expenseFields {
				f.AmountCents = 450000
				return f
			},
			want: []string{"amount Rs 5,000.00 → Rs 4,500.00"},
		},
		{
			name: "vendor only",
			new: func(f expenseFields) expenseFields {
				f.Vendor = "Mill"
				return f
			},
			want: []string{`vendor "Local Mill" → "Mill"`},
		},
		{
			name: "category cleared",
			new: func(f expenseFields) expenseFields {
				f.CategoryName = ""
				return f
			},
			want: []string{`category "Supplies" → none`},
		},
		{
			name: "category set from none",
			new: func(f expenseFields) expenseFields {
				f.CategoryName = "Rent"
				return f
			},
			want: []string{`category "Supplies" → "Rent"`},
		},
		{
			name: "date moved",
			new: func(f expenseFields) expenseFields {
				f.PaidAt = time.Date(2026, 6, 2, 10, 30, 0, 0, time.UTC)
				return f
			},
			want: []string{"date 2026-06-01 10:30 → 2026-06-02 10:30"},
		},
		{
			name: "reference + notes",
			new: func(f expenseFields) expenseFields {
				f.ReferenceNo = "INV-43"
				f.Notes = "biweekly flour"
				return f
			},
			want: []string{`reference "INV-42" → "INV-43"`, "notes updated"},
		},
		{
			name: "everything at once keeps amount first",
			new: func(f expenseFields) expenseFields {
				f.AmountCents = 100
				f.Vendor = "Other"
				return f
			},
			want: []string{"amount Rs 5,000.00 → Rs 1.00", `vendor "Local Mill" → "Other"`},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := expenseDiffClauses(base, tc.new(base))
			if len(got) != len(tc.want) {
				t.Fatalf("got %d clauses %v, want %d %v", len(got), got, len(tc.want), tc.want)
			}
			joined := strings.Join(got, "; ")
			for i, w := range tc.want {
				if got[i] != w {
					t.Errorf("clause %d = %q, want %q (full: %s)", i, got[i], w, joined)
				}
			}
		})
	}
}
