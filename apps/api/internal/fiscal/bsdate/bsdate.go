// Package bsdate converts between Gregorian (AD) and Bikram Sambat (BS) dates
// and derives Nepal's fiscal year.
//
// Everything an IRD document carries is dated in BS: the invoice date, the
// fiscal year ("2083.084" on the CBMS wire, "2083/84" on paper) and the
// per-fiscal-year numbering. BS month lengths are not computable — they are
// published yearly — so conversion walks the embedded table in table.go.
//
// All conversions take the civil date in Nepal (Asia/Kathmandu, UTC+05:45, no
// DST). FromTime does that conversion for you; never feed it a UTC date and
// expect the Nepali day — 00:30 NPT is still "yesterday" in UTC.
//
// The package is server-side only: clients receive BS strings from the API so
// there is exactly one calendar implementation to keep correct.
package bsdate

import (
	"errors"
	"fmt"
	"time"
)

// Date is a Bikram Sambat calendar date. Month is 1 (Baisakh) … 12 (Chaitra).
type Date struct {
	Year, Month, Day int
}

// ErrOutOfRange is returned for dates outside MinYear…MaxYear.
var ErrOutOfRange = errors.New("bsdate: date outside supported range")

// ErrInvalid is returned for a BS date that does not exist (e.g. day 32 of a
// 31-day month).
var ErrInvalid = errors.New("bsdate: invalid date")

// Nepal is the fixed Asia/Kathmandu zone. A fixed zone (not LoadLocation) so
// the package never depends on the host's tzdata; Nepal has observed +05:45
// without DST since 1986, which covers every date this system will issue.
var Nepal = time.FixedZone("NPT", 5*3600+45*60)

// epochAD is the Gregorian date of 2000-01-01 BS.
var epochAD = time.Date(1943, time.April, 14, 0, 0, 0, 0, time.UTC)

// yearStart[i] is the day offset from epochAD of 1 Baisakh of year MinYear+i.
var yearStart [MaxYear - MinYear + 2]int

func init() {
	off := 0
	for i, months := range monthDays {
		yearStart[i] = off
		for _, d := range months {
			off += int(d)
		}
	}
	yearStart[len(monthDays)] = off
}

// DaysInMonth returns the number of days in the given BS month.
func DaysInMonth(year, month int) (int, error) {
	if year < MinYear || year > MaxYear {
		return 0, ErrOutOfRange
	}
	if month < 1 || month > 12 {
		return 0, ErrInvalid
	}
	return int(monthDays[year-MinYear][month-1]), nil
}

// Valid reports whether d is a real BS date inside the supported range.
func (d Date) Valid() bool {
	n, err := DaysInMonth(d.Year, d.Month)
	return err == nil && d.Day >= 1 && d.Day <= n
}

// IsProvisional reports whether d falls in a year whose calendar is still a
// projection (see FirstProvisionalYear).
func (d Date) IsProvisional() bool { return d.Year >= FirstProvisionalYear }

// FromTime returns the BS date of the instant t as observed in Nepal.
func FromTime(t time.Time) (Date, error) {
	n := t.In(Nepal)
	return FromCivil(n.Year(), n.Month(), n.Day())
}

// FromCivil converts a Gregorian civil date (no time, no zone) to BS.
func FromCivil(year int, month time.Month, day int) (Date, error) {
	ad := time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
	days := int(ad.Sub(epochAD).Hours() / 24)
	if days < 0 || days >= yearStart[len(monthDays)] {
		return Date{}, ErrOutOfRange
	}
	// Binary search would be faster; 101 rows does not need it.
	yi := 0
	for yi+1 < len(monthDays) && yearStart[yi+1] <= days {
		yi++
	}
	rem := days - yearStart[yi]
	m := 0
	for rem >= int(monthDays[yi][m]) {
		rem -= int(monthDays[yi][m])
		m++
	}
	return Date{Year: MinYear + yi, Month: m + 1, Day: rem + 1}, nil
}

// ToCivil returns the Gregorian civil date of d as a midnight time.Time in the
// Nepal zone.
func (d Date) ToCivil() (time.Time, error) {
	if d.Year < MinYear || d.Year > MaxYear {
		return time.Time{}, ErrOutOfRange
	}
	if !d.Valid() {
		return time.Time{}, ErrInvalid
	}
	days := yearStart[d.Year-MinYear]
	for m := 0; m < d.Month-1; m++ {
		days += int(monthDays[d.Year-MinYear][m])
	}
	days += d.Day - 1
	ad := epochAD.AddDate(0, 0, days)
	return time.Date(ad.Year(), ad.Month(), ad.Day(), 0, 0, 0, 0, Nepal), nil
}

// String renders d as "2083-07-21" (ISO-like, used in our DTOs and reports).
func (d Date) String() string {
	return fmt.Sprintf("%04d-%02d-%02d", d.Year, d.Month, d.Day)
}

// CBMS renders d in the CBMS wire format "2083.07.21".
func (d Date) CBMS() string {
	return fmt.Sprintf("%04d.%02d.%02d", d.Year, d.Month, d.Day)
}

// Parse reads "2083-07-21" or "2083.07.21" and validates it.
func Parse(s string) (Date, error) {
	var d Date
	var sep1, sep2 byte
	if len(s) != 10 {
		return Date{}, ErrInvalid
	}
	sep1, sep2 = s[4], s[7]
	if sep1 != sep2 || (sep1 != '-' && sep1 != '.') {
		return Date{}, ErrInvalid
	}
	if _, err := fmt.Sscanf(s[0:4]+" "+s[5:7]+" "+s[8:10], "%d %d %d", &d.Year, &d.Month, &d.Day); err != nil {
		return Date{}, ErrInvalid
	}
	if d.Year < MinYear || d.Year > MaxYear {
		return Date{}, ErrOutOfRange
	}
	if !d.Valid() {
		return Date{}, ErrInvalid
	}
	return d, nil
}

// Before reports whether d is strictly earlier than o.
func (d Date) Before(o Date) bool {
	if d.Year != o.Year {
		return d.Year < o.Year
	}
	if d.Month != o.Month {
		return d.Month < o.Month
	}
	return d.Day < o.Day
}

// ---------------------------------------------------------------------------
// Fiscal year
// ---------------------------------------------------------------------------

// FiscalYear is a Nepali fiscal year, which runs 1 Shrawan (month 4) to the
// last day of Asar (month 3) of the following BS year. StartYear is the BS year
// in which it begins: FY 2083/84 has StartYear 2083.
type FiscalYear struct {
	StartYear int
}

// FiscalYearOf returns the fiscal year containing d.
func FiscalYearOf(d Date) FiscalYear {
	if d.Month >= 4 {
		return FiscalYear{StartYear: d.Year}
	}
	return FiscalYear{StartYear: d.Year - 1}
}

// FiscalYearOfTime is FiscalYearOf(FromTime(t)).
func FiscalYearOfTime(t time.Time) (FiscalYear, error) {
	d, err := FromTime(t)
	if err != nil {
		return FiscalYear{}, err
	}
	return FiscalYearOf(d), nil
}

// CBMS renders the fiscal year as the CBMS API expects: "2083.084".
func (f FiscalYear) CBMS() string {
	return fmt.Sprintf("%04d.%03d", f.StartYear, (f.StartYear+1)%1000)
}

// String renders the fiscal year for print and storage: "2083/84".
func (f FiscalYear) String() string {
	return fmt.Sprintf("%04d/%02d", f.StartYear, (f.StartYear+1)%100)
}

// First returns 1 Shrawan of the fiscal year.
func (f FiscalYear) First() Date { return Date{Year: f.StartYear, Month: 4, Day: 1} }

// Last returns the last day of Asar that ends the fiscal year.
func (f FiscalYear) Last() (Date, error) {
	n, err := DaysInMonth(f.StartYear+1, 3)
	if err != nil {
		return Date{}, err
	}
	return Date{Year: f.StartYear + 1, Month: 3, Day: n}, nil
}

// ParseFiscalYear reads "2083/84" or "2083.084".
func ParseFiscalYear(s string) (FiscalYear, error) {
	var y, z int
	switch {
	case len(s) == 7 && s[4] == '/':
		if _, err := fmt.Sscanf(s, "%4d/%2d", &y, &z); err != nil {
			return FiscalYear{}, ErrInvalid
		}
		if (y+1)%100 != z {
			return FiscalYear{}, ErrInvalid
		}
	case len(s) == 8 && s[4] == '.':
		if _, err := fmt.Sscanf(s, "%4d.%3d", &y, &z); err != nil {
			return FiscalYear{}, ErrInvalid
		}
		if (y+1)%1000 != z {
			return FiscalYear{}, ErrInvalid
		}
	default:
		return FiscalYear{}, ErrInvalid
	}
	if y < MinYear || y >= MaxYear {
		return FiscalYear{}, ErrOutOfRange
	}
	return FiscalYear{StartYear: y}, nil
}

// ---------------------------------------------------------------------------
// Month names
// ---------------------------------------------------------------------------

var monthNamesEN = [12]string{
	"Baisakh", "Jestha", "Asar", "Shrawan", "Bhadra", "Ashwin",
	"Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra",
}

var monthNamesNE = [12]string{
	"बैशाख", "जेठ", "असार", "साउन", "भदौ", "असोज",
	"कात्तिक", "मंसिर", "पुस", "माघ", "फागुन", "चैत",
}

// MonthName returns the English transliteration of a BS month (1-based).
func MonthName(m int) string {
	if m < 1 || m > 12 {
		return ""
	}
	return monthNamesEN[m-1]
}

// MonthNameNE returns the Nepali name of a BS month (1-based).
func MonthNameNE(m int) string {
	if m < 1 || m > 12 {
		return ""
	}
	return monthNamesNE[m-1]
}
