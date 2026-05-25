package mail

import (
	"fmt"
	"strings"
)

// OTPEmail is the prepared data for a sign-in code email. The OTP flow is
// pre-tenant, so CafeName/BrandColor default to the platform brand when the
// caller doesn't have a tenant on hand.
type OTPEmail struct {
	To         string
	Code       string
	TTLMinutes int
	CafeName   string // empty → "GoServe"
	BrandColor string // hex like "#FFA319"; empty → default amber
}

// BuildOTPMessage formats the code as a multipart/alt email styled to match
// the shift-summary template (gradient header, system fonts, light card on a
// muted page background). Subject contains the code so users skimming
// inboxes — especially on mobile — can grab it without opening the email.
func BuildOTPMessage(o OTPEmail) Message {
	cafe := o.CafeName
	if cafe == "" {
		cafe = "GoServe"
	}
	subject := fmt.Sprintf("Your sign-in code: %s — %s", o.Code, cafe)
	return Message{
		To:      []string{o.To},
		Subject: subject,
		HTML:    renderOTPHTML(o, cafe),
		Text:    renderOTPText(o, cafe),
	}
}

func renderOTPText(o OTPEmail, cafe string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Your sign-in code is %s\n", o.Code)
	fmt.Fprintf(&b, "It expires in %d minutes.\n\n", o.TTLMinutes)
	b.WriteString("If you didn't request this, you can safely ignore the email.\n\n")
	fmt.Fprintf(&b, "— %s\n", cafe)
	return b.String()
}

func renderOTPHTML(o OTPEmail, cafe string) string {
	color := o.BrandColor
	if color == "" {
		color = "#FFA319"
	}

	template := `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;color:#1a1d22;line-height:1.4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e1e4e8">
  <tr><td style="background:linear-gradient(135deg,{{COLOR}} 0%,#2a2e36 100%);padding:24px 28px;color:#fff">
    <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.85">Sign-in Code</div>
    <div style="font-size:22px;font-weight:600;margin-top:4px">{{CAFE_NAME}}</div>
  </td></tr>

  <tr><td style="padding:28px 28px 8px;text-align:center">
    <div style="font-size:12px;color:#6b7780;margin-bottom:14px">Use this code to finish signing in.</div>
    <div style="display:inline-block;background:#f7f8fa;border:1px solid #e1e4e8;border-radius:12px;padding:18px 22px;font:700 36px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.32em;color:#1a1d22">{{CODE}}</div>
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#6b7780;margin-top:16px">Expires in {{TTL}} minutes</div>
  </td></tr>

  <tr><td style="padding:18px 28px 24px">
    <div style="background:#fff8eb;border:1px solid #f5deb0;border-radius:10px;padding:12px 14px;font-size:12px;color:#6b5b1f">
      Didn't request this? You can safely ignore the email — the code will expire on its own.
    </div>
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid #e1e4e8;font-size:11px;color:#8a939b;text-align:center">
      Sent by {{CAFE_NAME}} · point of sale · inventory · floor
    </div>
  </td></tr>
</table>
</body></html>`

	replacements := map[string]string{
		"{{COLOR}}":     color,
		"{{CAFE_NAME}}": escapeHTML(cafe),
		"{{CODE}}":      escapeHTML(o.Code),
		"{{TTL}}":       fmt.Sprintf("%d", o.TTLMinutes),
	}
	out := template
	for k, v := range replacements {
		out = strings.ReplaceAll(out, k, v)
	}
	return out
}
