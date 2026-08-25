// Package mail sends transactional email via SendGrid's SMTP relay.
//
// Why SMTP and not the SendGrid HTTP API:
//   - Zero new module dependencies — net/smtp is in the Go standard library.
//   - SendGrid's SMTP relay accepts the same API key as the v3 HTTP API,
//     just username "apikey" + password "<API_KEY>" over TLS:587.
//   - Multi-provider portability: any SendGrid-compatible relay (Postmark,
//     Mailgun, AWS SES, self-hosted Postfix) drops in by swapping creds.
//
// The Mailer is safe to use as nil — Send becomes a no-op so dev/test
// environments that haven't set MAIL_* env never need to gate calls.
package mail

import (
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"sort"
	"strings"
	"time"
)

var base64Std = base64.StdEncoding

type Config struct {
	Host     string // e.g. smtp.sendgrid.net
	Port     int    // 587
	Username string // "apikey" for SendGrid
	Password string // the API key
	From     string // verified sender — what the recipient sees
	FromName string // optional display name
}

func (c Config) Enabled() bool {
	return c.Host != "" && c.Username != "" && c.Password != "" && c.From != ""
}

type Mailer struct {
	cfg Config
}

func New(cfg Config) *Mailer {
	if !cfg.Enabled() {
		return nil
	}
	return &Mailer{cfg: cfg}
}

type Message struct {
	To      []string
	Subject string
	HTML    string
	Text    string

	// From overrides the configured sender for this message. Used to send
	// scheduled, non-transactional mail from a DIFFERENT address than login
	// codes: a spam complaint about a morning brief must not be able to damage
	// the reputation that OTP delivery depends on. Empty uses Config.From.
	//
	// Note the SMTP envelope sender stays Config.From — the relay verifies that
	// address, and only the header changes.
	From     string
	FromName string

	// Headers are extra RFC 5322 headers, e.g. List-Unsubscribe on bulk mail.
	// Rendered in sorted order so a message is byte-identical across runs and
	// therefore testable. Values are sanitised: a newline in a header value
	// would let anything downstream inject arbitrary headers or a body.
	Headers map[string]string
}

// Send delivers msg via the configured SMTP relay. nil receiver = no-op so
// callers can construct messages unconditionally in dev. Returns an error
// only on real send failure; the caller is expected to log + carry on
// (delivery is best-effort — never block the user request on email).
func (m *Mailer) Send(msg Message) error {
	if m == nil {
		return nil
	}
	if len(msg.To) == 0 {
		return errors.New("no recipients")
	}
	if msg.Subject == "" {
		return errors.New("empty subject")
	}

	addr := net.JoinHostPort(m.cfg.Host, fmt.Sprintf("%d", m.cfg.Port))
	auth := smtp.PlainAuth("", m.cfg.Username, m.cfg.Password, m.cfg.Host)

	from := m.cfg.From
	fromName := m.cfg.FromName
	if msg.From != "" {
		from = msg.From
		fromName = msg.FromName
	}
	if fromName != "" {
		// Use UTF-8 mime-style display name to support non-ASCII cafe names.
		from = fmt.Sprintf("=?UTF-8?B?%s?= <%s>", encodeBase64(fromName), from)
	}

	headers := []string{
		"From: " + from,
		"To: " + strings.Join(msg.To, ", "),
		"Subject: " + mimeEncodeHeader(msg.Subject),
		"MIME-Version: 1.0",
	}
	// Sorted, so the rendered message is deterministic and can be asserted on.
	for _, k := range sortedKeys(msg.Headers) {
		if v := sanitiseHeader(msg.Headers[k]); v != "" {
			headers = append(headers, sanitiseHeader(k)+": "+v)
		}
	}

	var body string
	if msg.HTML != "" && msg.Text != "" {
		boundary := fmt.Sprintf("==cafe-%d==", time.Now().UnixNano())
		headers = append(headers, "Content-Type: multipart/alternative; boundary=\""+boundary+"\"")
		body = "\r\n--" + boundary + "\r\n" +
			"Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" +
			msg.Text + "\r\n" +
			"--" + boundary + "\r\n" +
			"Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" +
			msg.HTML + "\r\n" +
			"--" + boundary + "--\r\n"
	} else if msg.HTML != "" {
		headers = append(headers, "Content-Type: text/html; charset=UTF-8")
		body = "\r\n" + msg.HTML
	} else {
		headers = append(headers, "Content-Type: text/plain; charset=UTF-8")
		body = "\r\n" + msg.Text
	}

	payload := []byte(strings.Join(headers, "\r\n") + "\r\n" + body)

	// STARTTLS handshake on 587. SendGrid requires TLS; we don't fall back.
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	c, err := smtp.NewClient(conn, m.cfg.Host)
	if err != nil {
		return err
	}
	defer c.Quit()

	if err := c.StartTLS(&tls.Config{ServerName: m.cfg.Host}); err != nil {
		return err
	}
	if err := c.Auth(auth); err != nil {
		return err
	}
	if err := c.Mail(m.cfg.From); err != nil {
		return err
	}
	for _, rcpt := range msg.To {
		if err := c.Rcpt(rcpt); err != nil {
			return err
		}
	}
	wc, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := wc.Write(payload); err != nil {
		return err
	}
	return wc.Close()
}

func encodeBase64(s string) string {
	return base64Std.EncodeToString([]byte(s))
}

func mimeEncodeHeader(s string) string {
	// Cheap escape: if the header contains only ASCII printable, return
	// as-is; otherwise base64-encode for safe transport across SMTP.
	for _, r := range s {
		if r > 0x7e || r < 0x20 {
			return fmt.Sprintf("=?UTF-8?B?%s?=", encodeBase64(s))
		}
	}
	return s
}

// sortedKeys returns a map's keys in order, for deterministic header rendering.
func sortedKeys(m map[string]string) []string {
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// sanitiseHeader strips CR and LF. A newline in a header value is header
// injection: everything after it is parsed as a new header, or as the body.
func sanitiseHeader(v string) string {
	return strings.TrimSpace(strings.NewReplacer("\r", "", "\n", "").Replace(v))
}
