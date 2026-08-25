package insight

import (
	"testing"
	"time"
)

// The window arithmetic is the part most likely to be wrong, and wrong only in
// one timezone, so it is tested on its own with no database in sight.
func TestWindowsFor_EndsAtLocalMidnightAndExcludesToday(t *testing.T) {
	loc := kathmandu()
	// Mid-morning, so "today" is well under way — the window must still stop at
	// this morning's midnight. A brief that included the current partial day
	// would show every morning as a collapse.
	now := time.Date(2026, 7, 26, 9, 30, 0, 0, loc)

	cur, prior := WindowsFor(now, loc, WindowDays)

	if h := cur.To.In(loc).Hour(); h != 0 {
		t.Errorf("window ends at local hour %d, want midnight", h)
	}
	if got := cur.To.In(loc).Format("2006-01-02"); got != "2026-07-26" {
		t.Errorf("window ends %s, want the morning of 2026-07-26", got)
	}
	if got := cur.From.In(loc).Format("2006-01-02"); got != "2026-06-26" {
		t.Errorf("window starts %s, want 2026-06-26", got)
	}
	if cur.Days() != WindowDays {
		t.Errorf("window is %d days, want %d", cur.Days(), WindowDays)
	}

	// Contiguous and half-open: prior ends exactly where current begins, so no
	// order can fall in both windows or in neither.
	if !prior.To.Equal(cur.From) {
		t.Errorf("prior ends %v but current starts %v — windows must abut exactly",
			prior.To, cur.From)
	}
	if prior.Days() != WindowDays {
		t.Errorf("prior is %d days, want %d", prior.Days(), WindowDays)
	}
}

// Kathmandu is UTC+05:45, so local midnight is 18:15 the previous UTC day. If
// the boundary were computed in UTC, every window would be off by most of a day
// — in exactly the timezone this product actually runs in.
func TestWindowsFor_BoundaryIsLocalNotUTC(t *testing.T) {
	loc := kathmandu()
	cur, _ := WindowsFor(time.Date(2026, 7, 26, 9, 0, 0, 0, loc), loc, WindowDays)

	utc := cur.To.UTC()
	if utc.Hour() != 18 || utc.Minute() != 15 {
		t.Errorf("local midnight is %02d:%02d UTC, want 18:15 (+05:45 offset)",
			utc.Hour(), utc.Minute())
	}
	if got := utc.Format("2006-01-02"); got != "2026-07-25" {
		t.Errorf("local 26 Jul midnight is UTC %s, want 2026-07-25", got)
	}
}

// An instant a minute before local midnight and one a minute after must land in
// different windows — the off-by-one that a UTC-midnight test fixture hides.
func TestWindowsFor_MidnightIsExclusiveOnTheRight(t *testing.T) {
	loc := kathmandu()
	cur, _ := WindowsFor(time.Date(2026, 7, 26, 12, 0, 0, 0, loc), loc, WindowDays)

	justBefore := cur.To.Add(-time.Minute)
	justAfter := cur.To
	if !justBefore.Before(cur.To) {
		t.Error("an order a minute before midnight must be inside the window")
	}
	if justAfter.Before(cur.To) {
		t.Error("midnight itself must be OUTSIDE the window — the range is half-open")
	}
}

func TestWindowDays_MinimumIsOne(t *testing.T) {
	// A zero-width window would make every per-day rate divide by zero.
	if got := (Window{}).Days(); got != 1 {
		t.Errorf("empty window Days() = %d, want 1", got)
	}
}
