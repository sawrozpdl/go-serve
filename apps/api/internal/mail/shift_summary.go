package mail

import (
	"bytes"
	"fmt"
	"strings"
	"time"
)

// ShiftSummary is the prepared data for a shift-end email. Built inside the
// closing transaction (where RLS is set up), then handed off to a goroutine
// so the SMTP call never blocks the HTTP response.
type ShiftSummary struct {
	TenantName       string
	TenantSlug       string
	BrandColor       string // hex like "#FFA319"; empty = default amber
	OpenedAt         time.Time
	ClosedAt         time.Time
	OpenedByEmail    string
	ClosedByEmail    string
	Timezone         string
	OpeningFloat     int64
	ClosingCount     int64
	ExpectedCash     int64
	Variance         int64 // signed; negative = short
	CashIn           int64
	DropsIn          int64
	DropsOut         int64
	OrderCount       int
	SalesCents       int64
	TaxCents         int64
	ServiceCents     int64
	DiscountCents    int64
	VoidCount        int
	ExpensesCents    int64
	PaymentMethods   []MethodTotal
	TopSellers       []TopSeller
	Recipients       []string
	Notes            string
}

type MethodTotal struct {
	Method string
	Amount int64
	Count  int
}

type TopSeller struct {
	Name         string
	Qty          int
	RevenueCents int64
}

// BuildShiftSummaryMessage formats the summary as a multipart/alt email.
func BuildShiftSummaryMessage(s ShiftSummary) Message {
	tz, err := time.LoadLocation(s.Timezone)
	if err != nil {
		tz = time.UTC
	}
	openedLocal := s.OpenedAt.In(tz).Format("Mon Jan 2, 3:04 PM")
	closedLocal := s.ClosedAt.In(tz).Format("Mon Jan 2, 3:04 PM")

	subject := fmt.Sprintf("%s — Shift Closed (%s)", s.TenantName, closedLocal)
	html := renderShiftHTML(s, openedLocal, closedLocal)
	text := renderShiftText(s, openedLocal, closedLocal)
	return Message{
		To:      s.Recipients,
		Subject: subject,
		HTML:    html,
		Text:    text,
	}
}

func renderShiftText(s ShiftSummary, openedLocal, closedLocal string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Shift Closed — %s\n", s.TenantName)
	fmt.Fprintf(&b, "Opened: %s by %s\n", openedLocal, fallback(s.OpenedByEmail, "—"))
	fmt.Fprintf(&b, "Closed: %s by %s\n", closedLocal, fallback(s.ClosedByEmail, "—"))
	b.WriteString("\n— Sales —\n")
	fmt.Fprintf(&b, "Orders:        %d\n", s.OrderCount)
	fmt.Fprintf(&b, "Gross sales:   %s\n", npr(s.SalesCents))
	fmt.Fprintf(&b, "  VAT:         %s\n", npr(s.TaxCents))
	fmt.Fprintf(&b, "  Service:     %s\n", npr(s.ServiceCents))
	fmt.Fprintf(&b, "Discounts:     %s\n", npr(s.DiscountCents))
	fmt.Fprintf(&b, "Voids:         %d\n", s.VoidCount)
	fmt.Fprintf(&b, "Expenses:      %s\n", npr(s.ExpensesCents))
	b.WriteString("\n— Cash Drawer —\n")
	fmt.Fprintf(&b, "Opening float: %s\n", npr(s.OpeningFloat))
	fmt.Fprintf(&b, "Cash payments: %s\n", npr(s.CashIn))
	fmt.Fprintf(&b, "Drops in:      %s\n", npr(s.DropsIn))
	fmt.Fprintf(&b, "Drops out:     %s\n", npr(s.DropsOut))
	fmt.Fprintf(&b, "Expected:      %s\n", npr(s.ExpectedCash))
	fmt.Fprintf(&b, "Counted:       %s\n", npr(s.ClosingCount))
	fmt.Fprintf(&b, "Variance:      %s\n", signedNpr(s.Variance))
	if len(s.PaymentMethods) > 0 {
		b.WriteString("\n— Payments by Method —\n")
		for _, m := range s.PaymentMethods {
			fmt.Fprintf(&b, "  %-8s %4d × = %s\n", m.Method, m.Count, npr(m.Amount))
		}
	}
	if len(s.TopSellers) > 0 {
		b.WriteString("\n— Top Sellers —\n")
		for _, t := range s.TopSellers {
			fmt.Fprintf(&b, "  %-30s  %3d × = %s\n", trimTo(t.Name, 30), t.Qty, npr(t.RevenueCents))
		}
	}
	if s.Notes != "" {
		b.WriteString("\n— Notes —\n")
		b.WriteString(s.Notes)
		b.WriteString("\n")
	}
	return b.String()
}

func renderShiftHTML(s ShiftSummary, openedLocal, closedLocal string) string {
	color := s.BrandColor
	if color == "" {
		color = "#FFA319"
	}
	varianceColor := "#1a7f37"
	if s.Variance < 0 {
		varianceColor = "#cf222e"
	} else if s.Variance > 0 {
		varianceColor = "#bf7700"
	}

	var methods, sellers bytes.Buffer
	for _, m := range s.PaymentMethods {
		fmt.Fprintf(&methods, `<tr><td style="padding:6px 12px 6px 0;color:#384047">%s</td><td style="padding:6px 0;text-align:right;color:#6b7780">×%d</td><td style="padding:6px 0 6px 12px;text-align:right;font-variant-numeric:tabular-nums">%s</td></tr>`,
			capitalize(m.Method), m.Count, escapeHTML(npr(m.Amount)))
	}
	for i, t := range s.TopSellers {
		fmt.Fprintf(&sellers, `<tr><td style="padding:6px 12px 6px 0;color:#6b7780;width:24px">%d</td><td style="padding:6px 0;color:#384047">%s</td><td style="padding:6px 0;text-align:right;color:#6b7780">×%d</td><td style="padding:6px 0 6px 12px;text-align:right;font-variant-numeric:tabular-nums">%s</td></tr>`,
			i+1, escapeHTML(t.Name), t.Qty, escapeHTML(npr(t.RevenueCents)))
	}

	template := `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;color:#1a1d22;line-height:1.4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e1e4e8">
  <tr><td style="background:linear-gradient(135deg,{{COLOR}} 0%,#2a2e36 100%);padding:24px 28px;color:#fff">
    <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.85">Shift Closed</div>
    <div style="font-size:22px;font-weight:600;margin-top:4px">{{TENANT_NAME}}</div>
    <div style="font-size:12px;opacity:0.85;margin-top:6px">{{CLOSED_LOCAL}}</div>
  </td></tr>

  <tr><td style="padding:24px 28px">
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:18px">
      <div style="flex:1;min-width:140px">
        <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7780">Gross sales</div>
        <div style="font-size:22px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums">{{SALES}}</div>
      </div>
      <div style="flex:1;min-width:140px">
        <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7780">Orders</div>
        <div style="font-size:22px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums">{{ORDERS}}</div>
      </div>
      <div style="flex:1;min-width:140px">
        <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7780">Avg ticket</div>
        <div style="font-size:22px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums">{{AVG_TICKET}}</div>
      </div>
    </div>

    <div style="background:#f7f8fa;border-radius:10px;padding:16px 18px;margin-bottom:18px">
      <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7780;margin-bottom:10px">Cash drawer</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#384047">
        <tr><td style="padding:3px 0;color:#6b7780">Opening float</td><td style="text-align:right;font-variant-numeric:tabular-nums">{{OPENING}}</td></tr>
        <tr><td style="padding:3px 0;color:#6b7780">Cash payments</td><td style="text-align:right;font-variant-numeric:tabular-nums">{{CASH_IN}}</td></tr>
        <tr><td style="padding:3px 0;color:#6b7780">Drops in / out</td><td style="text-align:right;font-variant-numeric:tabular-nums">{{DROPS_IN}} / {{DROPS_OUT}}</td></tr>
        <tr><td style="padding:3px 0;color:#384047;font-weight:600">Expected</td><td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">{{EXPECTED}}</td></tr>
        <tr><td style="padding:3px 0;color:#384047;font-weight:600">Counted</td><td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">{{COUNTED}}</td></tr>
        <tr><td style="padding:6px 0 0;color:{{VAR_COLOR}};font-weight:600">Variance</td><td style="padding:6px 0 0;text-align:right;font-variant-numeric:tabular-nums;color:{{VAR_COLOR}};font-weight:600">{{VARIANCE}}</td></tr>
      </table>
    </div>

    {{METHODS_SECTION}}
    {{SELLERS_SECTION}}

    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:12px;color:#6b7780">
      <div>VAT: <span style="color:#384047;font-variant-numeric:tabular-nums">{{TAX}}</span></div>
      <div>Service: <span style="color:#384047;font-variant-numeric:tabular-nums">{{SERVICE}}</span></div>
      <div>Discounts: <span style="color:#384047;font-variant-numeric:tabular-nums">{{DISCOUNTS}}</span></div>
      <div>Voids: <span style="color:#384047;font-variant-numeric:tabular-nums">{{VOIDS}}</span></div>
      <div>Expenses: <span style="color:#384047;font-variant-numeric:tabular-nums">{{EXPENSES}}</span></div>
    </div>

    <div style="margin-top:24px;padding-top:14px;border-top:1px solid #e1e4e8;font-size:11px;color:#8a939b">
      Opened {{OPENED_LOCAL}} by {{OPENED_BY}}. Closed by {{CLOSED_BY}}. Timezone: {{TZ}}.
    </div>
  </td></tr>
</table>
</body></html>`

	avg := int64(0)
	if s.OrderCount > 0 {
		avg = s.SalesCents / int64(s.OrderCount)
	}

	methodsSection := ""
	if methods.Len() > 0 {
		methodsSection = `<div style="margin-bottom:18px"><div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7780;margin-bottom:8px">Payments by method</div><table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">` + methods.String() + `</table></div>`
	}
	sellersSection := ""
	if sellers.Len() > 0 {
		sellersSection = `<div style="margin-bottom:18px"><div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7780;margin-bottom:8px">Top sellers</div><table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">` + sellers.String() + `</table></div>`
	}

	replacements := map[string]string{
		"{{COLOR}}":           color,
		"{{TENANT_NAME}}":     escapeHTML(s.TenantName),
		"{{CLOSED_LOCAL}}":    escapeHTML(closedLocal),
		"{{SALES}}":           escapeHTML(npr(s.SalesCents)),
		"{{ORDERS}}":          fmt.Sprintf("%d", s.OrderCount),
		"{{AVG_TICKET}}":      escapeHTML(npr(avg)),
		"{{OPENING}}":         escapeHTML(npr(s.OpeningFloat)),
		"{{CASH_IN}}":         escapeHTML(npr(s.CashIn)),
		"{{DROPS_IN}}":        escapeHTML(npr(s.DropsIn)),
		"{{DROPS_OUT}}":       escapeHTML(npr(s.DropsOut)),
		"{{EXPECTED}}":        escapeHTML(npr(s.ExpectedCash)),
		"{{COUNTED}}":         escapeHTML(npr(s.ClosingCount)),
		"{{VARIANCE}}":        escapeHTML(signedNpr(s.Variance)),
		"{{VAR_COLOR}}":       varianceColor,
		"{{METHODS_SECTION}}": methodsSection,
		"{{SELLERS_SECTION}}": sellersSection,
		"{{TAX}}":             escapeHTML(npr(s.TaxCents)),
		"{{SERVICE}}":         escapeHTML(npr(s.ServiceCents)),
		"{{DISCOUNTS}}":       escapeHTML(npr(s.DiscountCents)),
		"{{VOIDS}}":           fmt.Sprintf("%d", s.VoidCount),
		"{{EXPENSES}}":        escapeHTML(npr(s.ExpensesCents)),
		"{{OPENED_LOCAL}}":    escapeHTML(openedLocal),
		"{{OPENED_BY}}":       escapeHTML(fallback(s.OpenedByEmail, "—")),
		"{{CLOSED_BY}}":       escapeHTML(fallback(s.ClosedByEmail, "—")),
		"{{TZ}}":              escapeHTML(s.Timezone),
	}

	out := template
	for k, v := range replacements {
		out = strings.ReplaceAll(out, k, v)
	}
	return out
}

func npr(cents int64) string {
	rs := cents / 100
	pa := cents % 100
	if pa < 0 {
		pa = -pa
	}
	if rs < 0 {
		return fmt.Sprintf("-Rs %d.%02d", -rs, pa)
	}
	return fmt.Sprintf("Rs %d.%02d", rs, pa)
}

func signedNpr(cents int64) string {
	if cents > 0 {
		return "+" + npr(cents)
	}
	return npr(cents)
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func escapeHTML(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&#39;")
	return r.Replace(s)
}

func fallback(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func trimTo(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
