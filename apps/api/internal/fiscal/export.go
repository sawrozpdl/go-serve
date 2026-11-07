package fiscal

import (
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"fmt"
	"io"
	"strconv"

	"github.com/xuri/excelize/v2"
)

// Exports of the IRD registers (procedure 2082 §6.1(घ): tables downloadable
// to Excel or XML, and PDF — the PDF is the web app's print of the same
// table). Money is written as rupees with two decimals.

// cell renders one value as text for CSV / XML.
func cell(c Column, v any) string {
	if v == nil {
		return ""
	}
	switch c.Kind {
	case ColMoney:
		if n, ok := toInt64(v); ok {
			return Money(n)
		}
	case ColBool:
		if b, ok := v.(bool); ok {
			if b {
				return "Yes"
			}
			return "No"
		}
	}
	return fmt.Sprint(v)
}

func toInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case int32:
		return int64(n), true
	case int:
		return int64(n), true
	}
	return 0, false
}

// totalsRow renders the totals line ("Total" in the first column).
func totalsRow(t *Table) []string {
	if len(t.Totals) == 0 {
		return nil
	}
	row := make([]string, len(t.Columns))
	row[0] = "Total"
	for i, c := range t.Columns {
		if c.Kind == ColMoney {
			row[i] = Money(t.Totals[c.Key])
		}
	}
	return row
}

// WriteCSV writes the register with its header block, a blank line, the
// column labels, the rows and the totals. UTF-8 with a BOM so Excel opens
// Nepali text correctly.
func WriteCSV(w io.Writer, t *Table) error {
	if _, err := w.Write([]byte("\xEF\xBB\xBF")); err != nil {
		return err
	}
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{t.Title})
	for _, h := range t.Header {
		_ = cw.Write([]string{h[0], h[1]})
	}
	_ = cw.Write(nil)
	labels := make([]string, len(t.Columns))
	for i, c := range t.Columns {
		labels[i] = c.Label
	}
	_ = cw.Write(labels)
	for _, r := range t.Rows {
		rec := make([]string, len(t.Columns))
		for i, c := range t.Columns {
			rec[i] = cell(c, r[i])
		}
		_ = cw.Write(rec)
	}
	if tr := totalsRow(t); tr != nil {
		_ = cw.Write(tr)
	}
	cw.Flush()
	return cw.Error()
}

// WriteXLSX writes the register as an Excel workbook: header block, bold
// column labels, numeric money cells formatted to two decimals, totals row.
func WriteXLSX(w io.Writer, t *Table) error {
	f := excelize.NewFile()
	defer f.Close()
	sheet := "Register"
	idx, err := f.NewSheet(sheet)
	if err != nil {
		return err
	}
	f.SetActiveSheet(idx)
	_ = f.DeleteSheet("Sheet1")

	bold, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	money, _ := f.NewStyle(&excelize.Style{NumFmt: 4}) // #,##0.00
	boldMoney, _ := f.NewStyle(&excelize.Style{NumFmt: 4, Font: &excelize.Font{Bold: true}})

	row := 1
	set := func(col, r int, v any) {
		name, _ := excelize.CoordinatesToCellName(col, r)
		_ = f.SetCellValue(sheet, name, v)
	}
	style := func(col, r, s int) {
		name, _ := excelize.CoordinatesToCellName(col, r)
		_ = f.SetCellStyle(sheet, name, name, s)
	}
	set(1, row, t.Title)
	style(1, row, bold)
	row++
	for _, h := range t.Header {
		set(1, row, h[0])
		set(2, row, h[1])
		row++
	}
	row++
	for i, c := range t.Columns {
		set(i+1, row, c.Label)
		style(i+1, row, bold)
	}
	row++
	for _, r := range t.Rows {
		for i, c := range t.Columns {
			switch c.Kind {
			case ColMoney:
				if n, ok := toInt64(r[i]); ok {
					set(i+1, row, float64(n)/100)
					style(i+1, row, money)
					continue
				}
			case ColInt:
				if n, ok := toInt64(r[i]); ok {
					set(i+1, row, n)
					continue
				}
			}
			set(i+1, row, cell(c, r[i]))
		}
		row++
	}
	if len(t.Totals) > 0 {
		set(1, row, "Total")
		style(1, row, bold)
		for i, c := range t.Columns {
			if c.Kind == ColMoney {
				set(i+1, row, float64(t.Totals[c.Key])/100)
				style(i+1, row, boldMoney)
			}
		}
	}
	for i := range t.Columns {
		name, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetColWidth(sheet, name, name, 16)
	}
	return f.Write(w)
}

// XML shape: <register kind=""><title/><header><field name="">…</field></header>
// <rows><row><Bill_no>…</Bill_no>…</row></rows><totals>…</totals></register>.
// Element names are the column keys (XML-safe); labels go in a <columns> list.
type xmlField struct {
	XMLName xml.Name
	Value   string `xml:",chardata"`
}

type xmlRegister struct {
	XMLName xml.Name `xml:"register"`
	Kind    string   `xml:"kind,attr"`
	Title   string   `xml:"title"`
	Header  []struct {
		Name  string `xml:"name,attr"`
		Value string `xml:",chardata"`
	} `xml:"header>field"`
	Columns []struct {
		Key   string `xml:"key,attr"`
		Label string `xml:",chardata"`
	} `xml:"columns>column"`
	Rows []struct {
		Fields []xmlField
	} `xml:"rows>row"`
	Totals []xmlField `xml:"totals>total,omitempty"`
}

// WriteXML writes the register as XML.
func WriteXML(w io.Writer, t *Table) error {
	x := xmlRegister{Kind: t.Kind, Title: t.Title}
	for _, h := range t.Header {
		x.Header = append(x.Header, struct {
			Name  string `xml:"name,attr"`
			Value string `xml:",chardata"`
		}{h[0], h[1]})
	}
	for _, c := range t.Columns {
		x.Columns = append(x.Columns, struct {
			Key   string `xml:"key,attr"`
			Label string `xml:",chardata"`
		}{c.Key, c.Label})
	}
	for _, r := range t.Rows {
		var fields []xmlField
		for i, c := range t.Columns {
			fields = append(fields, xmlField{XMLName: xml.Name{Local: c.Key}, Value: cell(c, r[i])})
		}
		x.Rows = append(x.Rows, struct{ Fields []xmlField }{fields})
	}
	for _, c := range t.Columns {
		if v, ok := t.Totals[c.Key]; ok {
			x.Totals = append(x.Totals, xmlField{XMLName: xml.Name{Local: c.Key}, Value: Money(v)})
		}
	}
	var buf bytes.Buffer
	buf.WriteString(xml.Header)
	enc := xml.NewEncoder(&buf)
	enc.Indent("", "  ")
	if err := enc.Encode(x); err != nil {
		return err
	}
	_, err := w.Write(buf.Bytes())
	return err
}

// ExportFilename is the download name: "sales_register_2083-84_m07.xlsx".
func ExportFilename(kind string, p Period, ext string) string {
	name := kind + "_" + strconv.Itoa(p.FY.StartYear) + "-" + fmt.Sprintf("%02d", (p.FY.StartYear+1)%100)
	if p.Month != 0 {
		name += fmt.Sprintf("_m%02d", p.Month)
	}
	return name + "." + ext
}
