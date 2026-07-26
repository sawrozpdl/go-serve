package api

// Unit tests for the money primitives. These are pure functions, so they run
// without a database — and they are the foundation every money breakdown in the
// app now rests on, so they get exhaustive treatment.

import (
	"math/rand"
	"testing"
)

func sumOf(xs []int64) int64 {
	var s int64
	for _, x := range xs {
		s += x
	}
	return s
}

func TestAllocateByShare_PartsAlwaysSumToTotal(t *testing.T) {
	cases := []struct {
		name    string
		total   int64
		weights []int64
		want    []int64
	}{
		{"even split", 100, []int64{1, 1}, []int64{50, 50}},
		{"exact thirds impossible", 100, []int64{1, 1, 1}, []int64{34, 33, 33}},
		{"single bucket takes all", 777, []int64{5}, []int64{777}},
		{"zero weights get nothing", 100, []int64{0, 1, 0}, []int64{0, 100, 0}},
		{"proportional", 1000, []int64{700, 300}, []int64{700, 300}},
		{"remainder to the largest", 10, []int64{7, 2, 1}, []int64{7, 2, 1}},
		{"one paisa, biggest share wins", 1, []int64{9, 1}, []int64{1, 0}},
		{"zero total", 0, []int64{3, 7}, []int64{0, 0}},
		{"negative weights ignored", 100, []int64{-5, 10}, []int64{0, 100}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := allocateByShare(c.total, c.weights)
			if len(got) != len(c.want) {
				t.Fatalf("len = %d, want %d", len(got), len(c.want))
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("allocateByShare(%d, %v) = %v, want %v",
						c.total, c.weights, got, c.want)
				}
			}
			if s := sumOf(got); s != c.total && c.total != 0 {
				t.Fatalf("parts sum to %d, want exactly %d", s, c.total)
			}
		})
	}
}

func TestAllocateByShare_NoWeights(t *testing.T) {
	if got := allocateByShare(500, nil); len(got) != 0 {
		t.Fatalf("nil weights should give an empty allocation, got %v", got)
	}
	got := allocateByShare(500, []int64{0, 0})
	if sumOf(got) != 0 {
		t.Fatalf("all-zero weights must allocate nothing, got %v", got)
	}
}

// The invariant that matters: whatever the inputs, the parts sum to the whole.
// Randomised over many shapes because this is the guarantee every breakdown in
// the UI leans on.
func TestAllocateByShare_SumInvariantRandomised(t *testing.T) {
	rng := rand.New(rand.NewSource(20260725)) // fixed seed: reproducible failures
	for i := 0; i < 3000; i++ {
		n := 1 + rng.Intn(12)
		weights := make([]int64, n)
		for j := range weights {
			weights[j] = int64(rng.Intn(100_000))
		}
		total := int64(rng.Intn(10_000_000))
		got := allocateByShare(total, weights)

		if sumOf(weights) == 0 {
			if sumOf(got) != 0 {
				t.Fatalf("zero weights but allocated %v", got)
			}
			continue
		}
		if s := sumOf(got); s != total {
			t.Fatalf("iteration %d: parts sum to %d, want %d (weights %v)",
				i, s, total, weights)
		}
		// No part may be negative, and no part may exceed the total.
		for j, v := range got {
			if v < 0 || v > total {
				t.Fatalf("iteration %d: part %d = %d, outside [0, %d]", i, j, v, total)
			}
		}
	}
}

// Allocation must be proportional, not just summing: a bucket with twice the
// weight gets (within a paisa) twice the money.
func TestAllocateByShare_IsProportional(t *testing.T) {
	got := allocateByShare(3000, []int64{2000, 1000})
	if got[0] != 2000 || got[1] != 1000 {
		t.Fatalf("got %v, want [2000 1000]", got)
	}
	// A tiny weight against a huge one still gets its share when it earns one.
	got = allocateByShare(1000, []int64{999, 1})
	if got[0] != 999 || got[1] != 1 {
		t.Fatalf("got %v, want [999 1]", got)
	}
}

// Half portions are the reason this exists: qty is numeric(6,2), so line
// revenue can carry a half paisa. Allocating the order's net revenue across the
// two categories must still land on the order total exactly.
func TestAllocateByShare_HalfPortionRounding(t *testing.T) {
	// Two half-plates at Rs 0.33 each: line weights 16.5 paisa → 16/17 as ints.
	// The order's net revenue is 33 paisa and must be fully attributed.
	got := allocateByShare(33, []int64{16, 17})
	if sumOf(got) != 33 {
		t.Fatalf("parts %v sum to %d, want 33", got, sumOf(got))
	}
}

func TestDivRound(t *testing.T) {
	cases := []struct{ num, den, want int64 }{
		{5000, 3, 1667}, // truncation would give 1666
		{5000, 2, 2500}, // exact
		{1, 2, 1},       // half rounds away from zero
		{-1, 2, -1},     // and symmetrically for negatives
		{-5000, 3, -1667},
		{7, 0, 0}, // divide by zero yields zero, not a panic
		{0, 5, 0},
	}
	for _, c := range cases {
		if got := divRound(c.num, c.den); got != c.want {
			t.Fatalf("divRound(%d, %d) = %d, want %d", c.num, c.den, got, c.want)
		}
	}
}
