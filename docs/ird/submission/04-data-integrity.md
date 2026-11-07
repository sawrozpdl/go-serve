# तथ्याङ्कको शुद्धता सुनिश्चित गर्ने व्यवस्था — Data integrity

*Go Serve, electronic billing for restaurants and cafés. Procedure 2082 §6.3(घ); 2074 §6(ख)(घ)(ट).*

## 1. What cannot change

Once issued, these records are permanent. No application user can edit or delete them, and neither can the database owner. Every table has a database trigger that refuses `UPDATE` and `DELETE` outright and raises a bilingual error (`fiscal_forbid_mutation`, migrations 0090–0094):

| Record | Table(s) |
|---|---|
| Tax invoice / invoice and its lines | `invoices`, `invoice_lines` |
| Sales return (CN-n) and reverse entry (RE-n) | `credit_notes`, `credit_note_lines`, `refunds` |
| Order slips (KOT-n) | `order_slips` |
| Print log (every copy, numbered) | `print_log` |
| Supplier bills and purchase returns | `purchase_bills`, `purchase_returns` |

**The bill behind an invoice is frozen too.** Once an order has an invoice, triggers refuse any change to the order row, its lines and add-ons, its discounts and its payments. The only exception is the kitchen's progress flags (ready or served), which are not on the bill.

**Number series can only move forward by one.** The `fiscal_sequences` trigger enforces this. A number is consumed inside the same transaction that issues the document, so a failed attempt leaves no gap. A test runs 20 bills settled in parallel and checks they get numbers 1–20 with no gaps or repeats.

**Deletion through relations is blocked.** Every foreign key into these tables is `ON DELETE RESTRICT`, so deleting a café's account cannot cascade into its bills. The admin console refuses to purge a café in IRD mode. An expense that carries a supplier bill can no longer be deleted.

## 2. How a correction is made

Corrections never edit the original. A **reverse entry** cancels a bill (same day, whole bill, with a reason). A **sales return** credits all or part of it (with a reason). Each correction is its own numbered, immutable document, kept in its own register and reported to CBMS. The original bill stays as it was, and the Standard View marks it `Is_bill_Active = false` once it is fully credited.

## 3. Proving nothing was altered

- **Per-document hash.** Every invoice and credit note stores the SHA-256 of its printed content (`content_hash`). Recomputing it from the stored row and comparing it shows whether the row is unchanged.
- **Hash-chained activity log.** Each café's activity log is a hash chain (migration 0095): every entry carries `chain_seq`, the previous entry's hash and its own hash. `audit_chain_verify(<café>)` walks the chain and names the first entry that does not match. A test edits one entry as the database owner and confirms the chain flags exactly that entry. The check is shown on Reports → IRD registers → Audit trail.
- **Derived status.** "Printed", "reported to IRD" and "active" are derived from append-only tables (`print_log`, `cbms_submissions`, `credit_notes`). An invoice row therefore never needs updating, and nothing is ever allowed to update it.

## 4. Who can write at all

| Role | What it can do |
|---|---|
| `app_user` (the application) | `SELECT` and `INSERT` on fiscal tables. No `UPDATE` or `DELETE` grants, no trigger rights. Row-level security confines it to one café per request. |
| `goserve` (database owner) | Runs migrations. Even this role cannot get past the triggers without disabling them. The production box admits only key-based SSH from one administrator, and every login is logged. |
| `ird_auditor` / `ird_<officer>` | Read-only views of the cafés IRD named, for a limited time (`docs/ird/IRD_ACCESS.md`). |

## 5. Evidence

The automated tests in `apps/api/internal/api/fiscal_*_test.go` prove every rule above against a real PostgreSQL database, for both the application role and the database owner. The refusal messages are in document 09.
