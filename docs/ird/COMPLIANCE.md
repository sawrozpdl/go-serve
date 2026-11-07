# IRD electronic billing: compliance map

This document maps each requirement of IRD's electronic billing rules to the place in Go Serve that meets it. It is the evidence index for the vendor listing (Annex 1) and for each café's permit inspection (§4(ग)).

**Governing texts**
- **2082:** विद्युतीय बीजक सम्बन्धी कार्यविधि, २०८२ (Electronic Billing Procedure 2082). In force from 2082/12/01; it repealed 2074.
- **2074:** विद्युतीय विजक सम्बन्धी कार्यविधि, २०७४ (४थो संशोधन). The IRD office told another vendor in October 2026 to meet every 2074 requirement, and that following 2082 as well is fine. **We build the superset of both.**
- **CBMS:** the CBMS Bill Posting API guide (updated 2079-06-28).
- **VAT Rules 2053:** rule 14ख (restaurant menu prices include VAT), rules 17 and 18 (tax invoice and abbreviated tax invoice), rule 20 (credit and debit notes).

Clause references are to 2082 unless marked 2074.

**Status legend**
- ✅ built and tested
- 🟡 partly built
- ⏳ planned (phase in brackets)
- ➖ not applicable (we declare the reason)
- ✍️ paperwork

The phases are those of the implementation plan: P0 foundations, P1 issuing, P2 printing, P3 CBMS, P4 corrections, P5 purchases, P6 reports and audit, P7 IRD access and operations, P8 documents, P9 freeze.

---

## Product decisions that shape compliance

| Decision | Why |
|---|---|
| **Registration type per café:** `none`, `pan` or `vat` (`fiscal_profiles.registration_type`). | Most small cafés are under the e-billing threshold or not VAT registered. `none` keeps today's receipt, marked "Not a tax invoice". |
| **Fiscal mode is per café and one-way** (`fiscal_profiles.fiscal_mode_enabled_at`, enforced by a trigger). | A café switches it on once it holds its IRD permit (Annex 4). From then on, every settle issues an invoice that cannot be edited or deleted. |
| **VAT cafés price VAT-inclusive.** A trigger forces `vat_mode = inclusive` and `vat_pct = 13`. | VAT Rule 14ख: hotel and restaurant menu prices include VAT. VAT is backed out at 13/113 on the bill. |
| **Service charge is 0 in fiscal mode** (trigger). | The Supreme Court struck down the statutory 10% service charge (2079-10-11). No law currently allows one. |
| **Invoice issued at settle** (inside the `CloseOrder` transaction). | A print taken before payment is an "ESTIMATE — NOT A TAX INVOICE" with no number. This avoids a locked-but-unpaid order state. |
| **Branch = tenant (0088). Each branch on a shared PAN has its own outlet code.** Enforced by a global unique index on `(pan, outlet_code)`. | §6.2(ग): each billing outlet numbers from 1 per fiscal year under its own code, so (PAN, FY, bill number) stays unique at CBMS. |
| **Offline:** settling needs a connection, so invoices are always issued online. | Item writes still queue offline. If offline settle is ever added, it prints a "provisional bill, not a tax invoice" and issues the real invoice on sync, posting to CBMS with `isrealtime=false`. |

**Not offered in v1, declared in the application:**
- **Abbreviated tax invoice.** Rule 17 always allows a full tax invoice, and rule 18 needs separate tax-office permission.
- **Debit notes.** Restaurant sales are paid at the counter. Corrections are sales returns and reverse entries.
- **2074 §6(त) / Annex 8 feed to payment operators.** The consumer VAT refund is not offered. The `VAT_Refund_Amount` column is 0. `Transaction_Id` carries the payment reference when there is one.
- **HS codes on lines.** Restaurant services; the column is left out of the thermal layout.

---

## Chapter 3: listing and permits

| Clause | Requirement | Status | Where |
|---|---|---|---|
| §3(क)(ख), Annex 1 | Producer applies through the Taxpayer Portal with a security test report and self-certification | ✍️ ⏳ P8/P9 | Annex 1 values sheet (P8). Security self-declaration (P9). |
| §3(घ) | A version change needs an updated security report; a name or technology change needs re-listing | 🟡 | Version in `apps/api/internal/version/VERSION`, shown on `/healthz`, `/me` (`server_version`) and every invoice (P2). Release log and CI path check: P9. |
| §4(ख), Annex 2/3 | Taxpayer applies with the producer's consent letter, declaring all branches | ⏳ P8 | Generators in Settings → Tax & IRD → Documents. |
| §4(ङ) | Add branches to an existing permit | ✅ | Branches are tenants. Each branch gets its own outlet code under the shared PAN. |

## Chapter 4: software standards (§6)

| Clause | Requirement | Status | Where |
|---|---|---|---|
| §6.1(क) | User-friendly | ✅ | Existing web and mobile POS. |
| §6.1(ख) | User management, password change, user manual, DB backup | 🟡 | Members and roles exist. **Login is passwordless (Google / emailed OTP)** — see question Q1. Manual: P8. Front-end backup: P6. |
| §6.1(ग) | Relational DB, log archive enabled, backups on a separate device | 🟡 | PostgreSQL 18 with WAL archiving (pgBackRest) and restic for uploads. **A second copy inside Nepal still has to be bought and added as pgBackRest `repo2`** (plan and drill log in `docs/ird/OPERATIONS.md` §1–2). |
| §6.1(घ), 2074 §6(ठ) | Tables exportable to Excel/XML and PDF from the front end | ✅ | Every register downloads as Excel, CSV or XML (`GET /v1/fiscal/registers/{kind}?format=`) and prints to PDF (Reports → IRD registers). Every table downloads in the records archive. Exports are audited. |
| §6.1(ङ) | Passwords stored encrypted | 🟡 | No user passwords are stored (Q1); OTP codes are hashed. CBMS passwords are AES-256-GCM sealed and bound to the tenant (`fiscal/secret.go`, `FISCAL_ENCRYPTION_KEY`). |
| §6.1(च) | Multi-user, multi-branch | ✅ | Roles and permissions; branches (0088). |
| §6.1(छ), Annex 5 | Standard View with the 20 attributes, printable | ✅ | SQL view `ird_materialized_view` (0096, `security_invoker`): the 20 Annex 5 attributes in IRD's order and names, derived from immutable records. `Sync_with_IRD` is true only for the real CBMS, not the mock. Shown, exported and printable in Reports → IRD registers. |
| §6.2(क), Annex 6 | Invoice format | ✅ | Thermal layout: web `apps/web/src/lib/invoicePrint.ts` (bilingual titles), mobile ESC/POS `packages/receipt-format/src/invoice.ts` (ASCII). Fields: seller name, address and PAN; title and copy marking; bill number and FY; transaction and issue dates (BS + AD, with time); buyer name, PAN and address; payment method (Cash/Cheque/Credit/Other); Txn ID; lines; Amount, Discount (%), Taxable, VAT 13%, Total; amount in words; QR; issued by; software version. |
| §6.2(ख) | Numbering from 1 per fiscal year | ✅ | `fiscal_sequences` (0090), consumed in the settle transaction by `fiscal.NextNumber`. No gaps on rollback; a concurrency test runs 20 parallel settles. BS calendar: `fiscal/bsdate`. |
| §6.2(ग) | Outlet code in the number for multiple outlets | ✅ | Outlet code on the profile, unique per PAN (0089). Printed in front of every number, e.g. `KTM-42` (`fiscal.FormatNumber`). |
| §6.2(घ) | **Hotels and restaurants: order slips numbered in sequence, logged, linked to the invoice** | ✅ | Each send-to-kitchen of a fiscal café writes an immutable `order_slips` row (`KOT-n` per fiscal year) holding its lines. It is linked to the invoice through `order_id` (`fiscal.RecordOrderSlip`). |
| §6.2(ङ) | Dynamic QR on every invoice | ✅ | Frozen at issue (`invoices.qr_payload`). Labelled text, readable offline: seller PAN, bill number, FY, BS date, buyer PAN, total, taxable, VAT. Switches to an IRD URL via `QR_VERIFY_BASE_URL` once published (Q10). Web renders it with `qrcode`; mobile uses the printer's native ESC/POS QR. |
| §6.2(च), 2074 §6(च) | Print once; reprints show "Copy of Original (n)" | ✅ | The server decides every label (`POST /v1/invoices/{id}/print`, `fiscal.InvoicePrintLabel`): 1 TAX INVOICE / ORIGINAL, 2 INVOICE / SECOND COPY, n Copy of Original (n−2). PAN-only invoices: ORIGINAL, then Copy of Original (n−1). `print_log` is append-only with a unique copy number, so concurrent prints never share an original (tested). Reprint is available from History on web and mobile (Q3). |
| §6.2(छ) | Issuing user's name, date and time on the invoice | ✅ | Snapshotted at issue (`issued_by_name`, `issued_at` from the server clock) and printed on every copy. |
| §6.2(ज) | Reverse entry and sales return, with reasons, in separate registers | ✅ | ✅ Built in `credit_notes` (0093), `kind` = `reversal` (RE-n: whole bill, same BS day, first correction only) or `sales_return` (CN-n: all or part, by line). Reason is required. Numbering is gap-free per series and FY. Both post to CBMS `/api/billreturn` against the bill's FY, and the return waits until its bill is on CBMS. The database refuses over-crediting per bill and per line, and rows are immutable. Refunds: cash comes out of the open shift's drawer (`cash_drops`); online is subtracted from the online account; credit lowers the house tab. Reverse & re-bill re-opens the lines on a new tab and puts the stock back. Separate Sales Return and Reverse Entry registers. |
| §6.3(क) | Sales, Purchase, Sales Return and Purchase Return registers | ✅ | Purchase side recorded: `purchase_bills` (0094) holds the supplier-bill detail of an expense (supplier PAN, bill number, BS date, exempt/taxable/VAT, import with customs declaration, capital). The total must equal the expense. A 13% VAT mismatch must be confirmed. Duplicate supplier bills per FY are refused. The row is immutable and the expense becomes undeletable. `purchase_returns` (PR-n) correct it. Registers: Sales Book (2082 layout + 2074 Discount), Sales Return, Reverse Entry, Purchase Book (Annex 6 §3 split), Purchase Return, VAT summary, and party-wise above Rs 1 lakh. All are under Reports → IRD registers. The exact CBMS Excel upload templates are still pending (Q5). |
| §6.3(ख)(ग), 2074 §6(ञ) | User activity log in the DB; audit trail viewable and printable | ✅ | `audit_log` is forced on for fiscal cafés (0089). It is append-only for the app role and **hash-chained per tenant** (0095: `chain_seq`, `prev_hash`, sha256 `hash`). `audit_chain_verify()` names the first altered row, as tested. The Audit Trail register is viewable, printable and exportable, and shows the chain status. |
| §6.3(घ), 2074 §6(ख)(ट) | No deletion or change of transactions from the front end **or the back end** | ✅ | ✅ `invoices`, `invoice_lines`, `order_slips` and `fiscal_sequences` refuse UPDATE and DELETE for every role, including the superuser (0090). The order behind an invoice (row, lines, add-ons, discounts, payments) is frozen too; only kitchen progress may still move. FKs RESTRICT, so a fiscal tenant cannot be purged or cascaded, and the super console refuses with `fiscal_tenant`. Each invoice and credit note carries a sha256 content hash. `credit_notes`, `credit_note_lines` and `refunds` are immutable too (0093). |
| §6.4(क), 2074 §6(ण) | Real-time CBMS via web API | ✅ | The outbox row (`cbms_submissions`, 0092) is written in the issuing transaction. The worker (`fiscal.CBMSWorker`) posts right after commit, then retries with backoff. 101 on a bill counts as synced. `isrealtime` is true only within 5 minutes of issue. `CBMS_MODE=off|mock|live`; mock syncs never count as reported and are re-queued when live posting starts. Credentials are the café's own IRD login, sealed with AES-256-GCM and never returned. Tested against an httptest fake of the API (`cbms/cbmstest`). |
| §6.4(ख) | Producer supplies data even after the contract ends | ✅ | "Download all records" (Settings → Tax & IRD, `GET /v1/fiscal/export`) gives a zip of every fiscal and operational table as CSV, plus the year's registers in Excel and a SHA-256 manifest. Fiscal cafés are never purged. |

## Chapter 4: server (§7.2, cloud)

| Clause | Requirement | Status | Where |
|---|---|---|---|
| §7.2(क) | Cloud provider registered in Nepal | ✅ ✍️ | DataHub, Kathmandu (production since 2026-11-04). |
| §7.2(ख) | Server in Nepal; the taxpayer informs IRD in advance | ✅ ✍️ | Server-location notice generator: P8. |
| §7.2(ग) | Multi-tenant, data separated | ✅ | Postgres row-level security on every tenant table (`current_tenant_id()`), with a two-pool isolation test harness. |
| §7.2(घ), Annex 7 | Three-party agreement | ⏳ P8 | |
| §7.2(ङ) | Bills posted to CBMS | ✅ | See §6.4(क). Bills issued before a café enters its login wait in the queue and post (non-real-time) once it does. |
| §7.2(च) | Temporary server with approval, number series unbroken | 🟡 | Runbook in `docs/ird/OPERATIONS.md` §4. Sequences live in the database, so a restore continues the series. A rehearsal is still to be recorded. |

## Chapters 5–6: operations and monitoring

| Clause | Requirement | Status | Where |
|---|---|---|---|
| §8(च), 2074 §8(घ) | DB and log backup per fiscal year, kept for the retention period | 🟡 | Continuous backups, plus a fiscal-year archive checklist (records zip + SHA-256 in both repos; `OPERATIONS.md` §3). An automatic sealing worker is planned. |
| §9 | Change of software: producer helps migrate | ✅ | The full records archive (§6.4(ख)). |
| §10, Annex 8 | Closing the permit | 🟡 | Write-lock in the super console (read-only, reprints and exports still work), final records archive, never purged (`OPERATIONS.md` §5). Annex 8 letter generator: P8. |
| §11 | IRD access to the server; monitoring | ✅ | Per-visit, per-taxpayer, time-limited read-only logins (`ird_auditor` + `ird_access_grants` + `ird_audit_*` views, 0097; `infra/datahub/ird-access.sh`). Tested: an officer sees only the granted café, no raw tables or credentials, and nothing after expiry. Procedure: `docs/ird/IRD_ACCESS.md`. |

---

## Questions for an IRD pre-application meeting

| # | Question | Blocks |
|---|---|---|
| Q1 | We store **no passwords**: login is Google or an emailed one-time code, stored hashed. Does that satisfy §6.1(ख)(ङ) "password change / passwords stored encrypted"? | Application text |
| Q2 | Must **PAN-only (non-VAT)** cafés post to CBMS? Which fields (e.g. `tax_exempted_sales`)? | P3 |
| Q3 | For thermal restaurant receipts, is the print sequence Tax Invoice → Invoice → Copy of Original (n) correct? | P2 |
| Q4 | Reverse-entry window ("तत्काल"): is the same day right? Is it posted through `/api/billreturn`? | P4 |
| Q5 | The CBMS Excel upload templates for the four registers (downloaded from the Taxpayer Portal). | P6 |
| Q6 | The primary server and DR site are in Nepal. Is it acceptable to also have a Cloudflare Tunnel in front of the API, a frontend served from a CDN, and an extra *encrypted* backup copy outside Nepal? | P7 |
| Q7 | Order slips (§6.2(घ)): numbered per fiscal year or per outlet? What must the log hold? | P1 |
| Q8 | Staff meals and complimentary items: is an invoice required (VAT Act s.12 market value)? Also confirm with a tax adviser. | P1 |
| Q9 | We deploy continuously. Which changes count as a "version change" that needs a new security report? | P9 |
| Q10 | The QR verification URL, once IRD publishes one. | P2 |

---

## Recurring checks

- **Yearly calendar check (every Chaitra).** BS month lengths are published yearly by the Nepal Panchanga Nirnayak Samiti. Rows from `bsdate.FirstProvisionalYear` (currently 2084) onward in `apps/api/internal/fiscal/bsdate/table.go` are projections. When the official calendar for the coming year is out:
  1. compare its month lengths with the table;
  2. correct the row if needed;
  3. add an anchor to `bsdate_test.go`;
  4. bump `FirstProvisionalYear`.

  The FY 2083/84 numbering crosses into 2084 on 1 Baisakh 2084 (about 2027-04-14), so **2084 must be verified before then**.
- **Version bump.** Bump `apps/api/internal/version/VERSION` for every release that changes anything IRD reviewed. P9 adds a release log.
