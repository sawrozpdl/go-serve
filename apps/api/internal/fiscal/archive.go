package fiscal

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/bsdate"
	"github.com/pewssh/cafe-mgmt/api/internal/version"
)

// The café's full records export ("download all records"): every fiscal
// table and the operational tables behind them as CSV, the IRD registers of
// a fiscal year as Excel, and a manifest with the SHA-256 of every file.
// It serves three clauses at once:
//   - 2074 §6(ड), 2082 §6.1(ख): an authorised user can back up the database
//     from the front end;
//   - 2082 §6.4(ख), §9(ङ), §11(च): the producer hands the taxpayer its data
//     (on leaving, on changing software, or when IRD asks);
//   - §6.1(घ): tables exportable from the front end.
// Rows come through the caller's RLS scope, so the archive is one café's
// data only. Credentials and outbox payloads are excluded.

// archiveTables lists what goes in, with the query for each. Secrets are
// never selected (fiscal_profiles drops the CBMS password).
var archiveTables = []struct{ name, query string }{
	{"fiscal_profile", `SELECT tenant_id, registration_type, pan, legal_name, legal_name_ne, address, phone, email,
		tax_office, permit_no, outlet_code, fiscal_mode_enabled_at, cbms_enabled, cbms_username, created_at, updated_at
		FROM fiscal_profiles`},
	{"invoices", `SELECT * FROM invoices ORDER BY fiscal_year, seq`},
	{"invoice_lines", `SELECT * FROM invoice_lines ORDER BY invoice_id, line_no`},
	{"credit_notes", `SELECT * FROM credit_notes ORDER BY fiscal_year, kind, seq`},
	{"credit_note_lines", `SELECT * FROM credit_note_lines ORDER BY credit_note_id, line_no`},
	{"refunds", `SELECT * FROM refunds ORDER BY recorded_at`},
	{"order_slips", `SELECT * FROM order_slips ORDER BY fiscal_year, seq`},
	{"print_log", `SELECT * FROM print_log ORDER BY printed_at`},
	{"cbms_submissions", `SELECT id, tenant_id, doc_type, doc_id, endpoint, issued_at, status, attempts, last_code,
		last_error, next_attempt_at, synced_at, synced_via, is_realtime, created_at FROM cbms_submissions ORDER BY issued_at`},
	{"purchase_bills", `SELECT * FROM purchase_bills ORDER BY supplier_bill_date`},
	{"purchase_returns", `SELECT * FROM purchase_returns ORDER BY fiscal_year, seq`},
	{"fiscal_sequences", `SELECT * FROM fiscal_sequences ORDER BY doc_type, fiscal_year`},
	{"audit_log", `SELECT * FROM audit_log ORDER BY created_at, chain_seq NULLS FIRST`},
	{"orders", `SELECT * FROM orders ORDER BY opened_at`},
	{"order_items", `SELECT * FROM order_items ORDER BY created_at`},
	{"payments", `SELECT * FROM payments ORDER BY recorded_at`},
	{"expenses", `SELECT * FROM expenses ORDER BY paid_at`},
}

type manifestFile struct {
	Name   string `json:"name"`
	Rows   int    `json:"rows,omitempty"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// WriteRecordsArchive streams the zip to w.
func WriteRecordsArchive(ctx context.Context, tx pgx.Tx, w io.Writer, prof Profile, fy bsdate.FiscalYear) error {
	zw := zip.NewWriter(w)
	var files []manifestFile
	add := func(name string, data []byte, rows int) error {
		f, err := zw.Create(name)
		if err != nil {
			return err
		}
		if _, err := f.Write(data); err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		files = append(files, manifestFile{Name: name, Rows: rows, Bytes: len(data), SHA256: hex.EncodeToString(sum[:])})
		return nil
	}

	for _, t := range archiveTables {
		data, n, err := queryCSV(ctx, tx, t.query)
		if err != nil {
			return fmt.Errorf("fiscal: export %s: %w", t.name, err)
		}
		if err := add("tables/"+t.name+".csv", data, n); err != nil {
			return err
		}
	}
	for _, k := range RegisterKinds {
		tbl, err := BuildRegister(ctx, tx, k.Kind, Period{FY: fy}, prof)
		if err != nil {
			return fmt.Errorf("fiscal: export register %s: %w", k.Kind, err)
		}
		var buf bytes.Buffer
		if err := WriteXLSX(&buf, tbl); err != nil {
			return err
		}
		if err := add("registers/"+ExportFilename(k.Kind, Period{FY: fy}, "xlsx"), buf.Bytes(), len(tbl.Rows)); err != nil {
			return err
		}
	}

	manifest, _ := json.MarshalIndent(map[string]any{
		"software":     version.String(),
		"generated_at": time.Now().In(bsdate.Nepal).Format(time.RFC3339),
		"taxpayer":     prof.LegalName,
		"pan":          prof.PAN,
		"fiscal_year":  fy.String(),
		"files":        files,
		"note":         "SHA-256 of each file is listed; recompute to confirm the archive is unchanged.",
	}, "", "  ")
	f, err := zw.Create("manifest.json")
	if err != nil {
		return err
	}
	if _, err := f.Write(manifest); err != nil {
		return err
	}
	return zw.Close()
}

// queryCSV renders a query as CSV with a header row.
func queryCSV(ctx context.Context, tx pgx.Tx, q string) ([]byte, int, error) {
	rows, err := tx.Query(ctx, q)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var buf bytes.Buffer
	buf.WriteString("\xEF\xBB\xBF")
	cw := csv.NewWriter(&buf)
	var header []string
	for _, fd := range rows.FieldDescriptions() {
		header = append(header, fd.Name)
	}
	_ = cw.Write(header)
	n := 0
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, 0, err
		}
		rec := make([]string, len(vals))
		for i, v := range vals {
			rec[i] = csvValue(v)
		}
		_ = cw.Write(rec)
		n++
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	cw.Flush()
	return buf.Bytes(), n, cw.Error()
}

func csvValue(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case time.Time:
		return x.UTC().Format(time.RFC3339Nano)
	case [16]byte:
		return fmt.Sprintf("%x-%x-%x-%x-%x", x[0:4], x[4:6], x[6:8], x[8:10], x[10:16])
	case []byte:
		return hex.EncodeToString(x)
	case string:
		return x
	default:
		if b, err := json.Marshal(x); err == nil {
			s := string(b)
			if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
				var str string
				if json.Unmarshal(b, &str) == nil {
					return str
				}
			}
			return s
		}
		return fmt.Sprint(x)
	}
}
