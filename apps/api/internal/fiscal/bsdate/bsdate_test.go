package bsdate

import (
	"testing"
	"time"
)

// Anchors are independent of table.go: New Year (1 Baisakh) dates as published
// by Nepal's government calendar, the epoch every converter uses, and one date
// from an IRD-facing document (2083-06-18 BS = 2026-10-04, dated in both
// calendars in the reference notes).
var anchors = []struct {
	bs Date
	ad string
}{
	{Date{2000, 1, 1}, "1943-04-14"},
	{Date{2070, 1, 1}, "2013-04-14"},
	{Date{2080, 1, 1}, "2023-04-14"},
	{Date{2081, 1, 1}, "2024-04-13"},
	{Date{2082, 1, 1}, "2025-04-14"},
	{Date{2082, 12, 1}, "2026-03-15"}, // Procedure 2082 in force
	{Date{2083, 1, 1}, "2026-04-14"},
	{Date{2083, 4, 1}, "2026-07-17"}, // FY 2083/84 begins (1 Shrawan)
	{Date{2083, 6, 18}, "2026-10-04"},
	{Date{2083, 7, 21}, "2026-11-07"},
}

func TestAnchorsBothWays(t *testing.T) {
	for _, a := range anchors {
		ad, _ := time.Parse("2006-01-02", a.ad)
		got, err := FromCivil(ad.Year(), ad.Month(), ad.Day())
		if err != nil || got != a.bs {
			t.Errorf("FromCivil(%s) = %v, %v; want %v", a.ad, got, err, a.bs)
		}
		back, err := a.bs.ToCivil()
		if err != nil || back.Format("2006-01-02") != a.ad {
			t.Errorf("ToCivil(%v) = %v, %v; want %s", a.bs, back, err, a.ad)
		}
	}
}

func TestRoundTripEveryDay(t *testing.T) {
	start := time.Date(1943, 4, 14, 0, 0, 0, 0, time.UTC)
	prev := Date{}
	for i := 0; ; i++ {
		ad := start.AddDate(0, 0, i)
		d, err := FromCivil(ad.Year(), ad.Month(), ad.Day())
		if err == ErrOutOfRange {
			if d.Year == 0 && prev.Year != MaxYear {
				t.Fatalf("ran out of range at %v (prev %v)", ad, prev)
			}
			break
		}
		if !d.Valid() {
			t.Fatalf("invalid %v from %v", d, ad)
		}
		if i > 0 && !prev.Before(d) {
			t.Fatalf("not monotonic: %v then %v", prev, d)
		}
		back, _ := d.ToCivil()
		if back.Format("2006-01-02") != ad.Format("2006-01-02") {
			t.Fatalf("round trip %v -> %v -> %v", ad, d, back)
		}
		prev = d
	}
}

func TestFromTimeUsesNepalDay(t *testing.T) {
	// 2026-11-06 19:00 UTC is 2026-11-07 00:45 in Nepal.
	utc := time.Date(2026, 11, 6, 19, 0, 0, 0, time.UTC)
	d, err := FromTime(utc)
	if err != nil || d != (Date{2083, 7, 21}) {
		t.Fatalf("FromTime = %v, %v", d, err)
	}
}

func TestFiscalYear(t *testing.T) {
	cases := []struct {
		d    Date
		fy   string
		cbms string
	}{
		{Date{2083, 3, 32}, "2082/83", "2082.083"},
		{Date{2083, 4, 1}, "2083/84", "2083.084"},
		{Date{2083, 7, 21}, "2083/84", "2083.084"},
		{Date{2084, 1, 1}, "2083/84", "2083.084"},
		{Date{2099, 4, 1}, "2099/00", "2099.100"},
	}
	for _, c := range cases {
		if !c.d.Valid() {
			t.Fatalf("test date %v invalid", c.d)
		}
		fy := FiscalYearOf(c.d)
		if fy.String() != c.fy || fy.CBMS() != c.cbms {
			t.Errorf("%v: got %s / %s, want %s / %s", c.d, fy, fy.CBMS(), c.fy, c.cbms)
		}
		p1, err := ParseFiscalYear(c.fy)
		p2, err2 := ParseFiscalYear(c.cbms)
		if err != nil || err2 != nil || p1 != fy || p2 != fy {
			t.Errorf("parse %s/%s = %v,%v / %v,%v", c.fy, c.cbms, p1, err, p2, err2)
		}
	}
	last, err := FiscalYear{2082}.Last()
	if err != nil || last != (Date{2083, 3, 32}) {
		t.Fatalf("FY 2082/83 last = %v, %v", last, err)
	}
}

func TestParseAndFormat(t *testing.T) {
	d, err := Parse("2083.07.21")
	if err != nil || d != (Date{2083, 7, 21}) || d.CBMS() != "2083.07.21" || d.String() != "2083-07-21" {
		t.Fatalf("Parse = %v %v", d, err)
	}
	for _, bad := range []string{"2083-07-32", "2083/07/21", "2083-13-01", "1999-01-01", "2083-07.21", "abcd-ef-gh"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("Parse(%q) accepted", bad)
		}
	}
	if _, err := ParseFiscalYear("2083/85"); err == nil {
		t.Error("ParseFiscalYear accepted mismatched pair")
	}
}

func TestProvisional(t *testing.T) {
	if (Date{2083, 12, 30}).IsProvisional() {
		t.Error("2083 should be official")
	}
	if !(Date{2084, 1, 1}).IsProvisional() {
		t.Error("2084 should be provisional")
	}
}

func TestMonthNames(t *testing.T) {
	if MonthName(4) != "Shrawan" || MonthNameNE(7) != "कात्तिक" || MonthName(0) != "" {
		t.Fatal("month names")
	}
}
