package fiscal

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms"
)

// CBMSCredentialsInput is an owner's change to the café's CBMS login.
type CBMSCredentialsInput struct {
	Enabled  bool
	Username string
	// Password nil = keep the stored one; "" is rejected when enabling.
	Password *string
}

// SaveCBMSCredentials stores the café's IRD login (password sealed with
// AES-256-GCM, bound to the tenant) and, when enabled, puts every waiting
// submission back at the front of the queue so the backlog posts at once.
func SaveCBMSCredentials(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, in CBMSCredentialsInput) error {
	in.Username = strings.TrimSpace(in.Username)
	if len(in.Username) > 120 {
		return fmt.Errorf("username too long")
	}
	var sealed []byte
	keyID := ""
	if in.Password != nil {
		if *in.Password == "" || len(*in.Password) > 200 {
			return fmt.Errorf("enter the CBMS password")
		}
		var err error
		if sealed, err = sealSecret(settings.EncryptionKey, *in.Password, tenantID.String()); err != nil {
			return err
		}
		keyID = settings.KeyID
	}
	tag, err := tx.Exec(ctx, `
		UPDATE fiscal_profiles
		SET cbms_username     = $2,
		    cbms_password_enc = COALESCE($3, cbms_password_enc),
		    cbms_key_id       = CASE WHEN $3::bytea IS NULL THEN cbms_key_id ELSE $4 END,
		    cbms_enabled      = $5
		WHERE tenant_id = $1
	`, tenantID, in.Username, sealed, keyID, in.Enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("save the tax profile first")
	}
	if in.Enabled {
		if _, err := tx.Exec(ctx, `
			UPDATE cbms_submissions SET next_attempt_at = now()
			WHERE tenant_id = $1 AND status = 'pending'
		`, tenantID); err != nil {
			return err
		}
		if k := settings.Kick; k != nil {
			afterCommit(ctx, k)
		}
	}
	return nil
}

// ConnectionResult is the outcome of a CBMS login check.
type ConnectionResult struct {
	OK      bool   `json:"ok"`
	Mode    string `json:"mode"`
	Code    int    `json:"code,omitempty"`
	Message string `json:"message"`
}

// TestCBMSConnection checks the café's stored login against CBMS without
// creating anything: it posts a sales return for a bill number that cannot
// exist. A valid login is answered "bill does not exist" (105/101); a wrong
// one, 100. CBMS has no other way to ask "is this login valid?".
func TestCBMSConnection(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (ConnectionResult, error) {
	res := ConnectionResult{Mode: settings.CBMSMode}
	if settings.CBMS == nil {
		res.Message = "CBMS posting is switched off on this server"
		return res, nil
	}
	p, err := LoadProfile(ctx, tx, tenantID)
	if err != nil {
		return res, err
	}
	if p.PAN == "" || p.CBMSUsername == "" || !p.CBMSPasswordSet {
		res.Message = "enter the IRD username and password first"
		return res, nil
	}
	creds := cbms.Credentials{Username: p.CBMSUsername, SellerPAN: p.PAN}
	if settings.CBMS.Name() == "live" {
		key, err := keyFor(p.CBMSKeyID)
		if err == nil {
			creds.Password, err = openSecret(key, p.CBMSPasswordEnc, tenantID.String())
		}
		if err != nil {
			res.Message = err.Error()
			return res, nil
		}
	}
	now := time.Now()
	bs, _ := bsdate.FromTime(now)
	stamp := now.UTC().Format("20060102150405")
	doc, _ := json.Marshal(cbms.Return{
		FiscalYear:       bsdate.FiscalYearOf(bs).CBMS(),
		RefInvoiceNumber: "GOSERVE-CONNECTION-TEST-" + stamp,
		CreditNoteNumber: "TEST-" + stamp,
		CreditNoteDate:   bs.CBMS(),
		ReasonForReturn:  "connection test",
	})
	r, err := settings.CBMS.Post(ctx, cbms.Envelope{
		Endpoint: cbms.EndpointBillReturn, Creds: creds, Document: doc,
		DatetimeClient: now.In(bsdate.Nepal).Format("2006-01-02T15:04:05"),
	})
	if err != nil {
		res.Message = "could not reach CBMS: " + err.Error()
		return res, nil
	}
	res.Code = r.Code
	switch r.Code {
	case cbms.CodeBadCredentials:
		res.Message = "IRD rejected the username or password"
	case cbms.CodeBillNotFound, cbms.CodeDuplicate, cbms.CodeSuccess:
		res.OK = true
		res.Message = "login accepted by CBMS"
		if settings.CBMS.Name() == "mock" {
			res.Message = "mock CBMS accepted the request (nothing reaches IRD in mock mode)"
		}
	default:
		res.Message = "unexpected CBMS answer: " + r.Raw
	}
	return res, nil
}

// CBMSCounts summarises a café's reporting backlog.
type CBMSCounts struct {
	Pending int `json:"pending"`
	Failed  int `json:"failed"`
	Synced  int `json:"synced"`
}

// LoadCBMSCounts counts the café's submissions by status ('synced' counts
// only real CBMS answers, never the mock's).
func LoadCBMSCounts(ctx context.Context, tx pgx.Tx) (CBMSCounts, error) {
	var c CBMSCounts
	err := tx.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status = 'pending'),
		       count(*) FILTER (WHERE status = 'failed'),
		       count(*) FILTER (WHERE status = 'synced' AND synced_via = 'live')
		FROM cbms_submissions
	`).Scan(&c.Pending, &c.Failed, &c.Synced)
	return c, err
}
