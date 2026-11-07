# IRD access to a café's records

This document describes how the Inland Revenue Department, or a tax officer it authorises, inspects a café's billing data on the Go Serve server.

The procedure requires:
- 2082 §11(क)–(घ): the department and the tax office can access the server, inspect it at any time, and be given the documents, tools and staff they need.
- 2074 §7(ख)(३) and §9: the same, under the earlier procedure.

## 1. What an officer can use

| Route | For | Contains |
|---|---|---|
| **The web app**, with a member account the café creates for the officer (a role holding `fiscal:read`, plus `report:read` for the Reports menu) | An on-site inspection, or a café-arranged review | Reports → IRD registers: the Standard View (Annex 5), Sales Book, Sales Return and Reverse Entry registers, Purchase Book, Purchase Returns, VAT summary, transactions above Rs 1 lakh, KOT log, print log, CBMS status, audit trail with chain check. Each is printable and downloads to Excel, CSV or XML. Every view and export is itself in the audit trail. |
| **Records archive** (Settings → Tax & IRD → Download all records) | Handing data over: on request, at the end of a contract (§6.4(ख)), or on a change of software (§9) | A zip of every fiscal and operational table as CSV, the year's registers in Excel, and a manifest with each file's SHA-256 |
| **Read-only database login** `ird_<officer>` | IRD IT officers who want to query directly | The `ird_audit_*` views, limited to the cafés named in IRD's written request, until the login expires |

## 2. Database access: one login per visit, per taxpayer

These pieces come from migration 0097 and `infra/datahub/ird-access.sh`.

- **`ird_auditor`** is a NOLOGIN group role. It can `SELECT` from five views and do nothing else. It cannot read raw tables, other cafés, settings or CBMS credentials, and it cannot write anything.
  - `ird_audit_standard_view`: Annex 5, all 20 attributes, plus `org`, `seller_pan` and `seller_name`.
  - `ird_audit_credit_notes`: sales returns and reverse entries.
  - `ird_audit_purchase_book`
  - `ird_audit_trail`: includes `chain_seq`, `prev_hash` and `hash`.
  - `ird_audit_print_log`
- **Each visit gets its own login, `ird_<officer>`.** The login:
  - is a member of `ird_auditor`;
  - has a random password, printed once;
  - is valid for 1–30 days (`VALID UNTIL`), with at most 3 connections;
  - is recorded in `ird_access_grants` (login, café, expiry, reason, who granted it).
- **Every view filters on `ird_can_see(tenant_id)`.** That check is true only for a live, unrevoked grant to the connected login. A test covers this: an officer granted café A sees A's bills and none of B's; cannot read `invoices` or `fiscal_profiles`; cannot grant itself more access; and sees nothing once the grant expires (`fiscal_ird_access_test.go`).
- **The integrity triggers apply to every role**, including the database owner. Fiscal records cannot be changed or deleted through any login.

### Granting access

1. IRD sends a written request naming the officer, the taxpayer(s) and the period.
2. On the server:
   ```bash
   sudo infra/datahub/ird-access.sh grant ram_sharma sahan,sahan-thamel 7 "IRD letter 2083/123 — VAT audit FY 2082/83"
   ```
   The command prints the login and the password **once**. Give the password over a separate channel, by phone or in person.
3. Connecting. Postgres listens only on the box's loopback, so allow the officer's IP on the DataHub port-22 rule. Create a forwarding-only SSH account in `authorized_keys`: `restrict,port-forwarding,permitopen="localhost:5432" ssh-ed25519 …`. Then:
   ```bash
   ssh -N -L 5433:localhost:5432 ird-visit@<box>
   psql "postgresql://ird_ram_sharma@localhost:5433/goserve"
   ```
4. Afterwards, run `sudo infra/datahub/ird-access.sh revoke ram_sharma`, remove the SSH account and the firewall rule. `ird-access.sh list` shows every grant ever made.

### Useful queries for the officer

```sql
-- Bills for Kartik 2083 of one café
SELECT * FROM ird_audit_standard_view WHERE org = 'sahan' AND "Bill_Date" LIKE '2083-07-%' ORDER BY seq;

-- Gaps in numbering (there should be none: count = max − min + 1)
SELECT org, "Fiscal_Year", min(seq), max(seq), count(*) FROM ird_audit_standard_view GROUP BY 1, 2;

-- Bills not yet on CBMS
SELECT org, "Bill_no", "Bill_Date" FROM ird_audit_standard_view WHERE NOT "Sync_with_IRD";

-- Corrections
SELECT * FROM ird_audit_credit_notes ORDER BY issued_at;

-- Audit trail; each row's prev_hash must equal the previous row's hash
SELECT chain_seq, created_at, actor_name, action, summary, prev_hash, hash FROM ird_audit_trail WHERE org = 'sahan' ORDER BY chain_seq;
```

## 3. Not yet automated

- Creating and removing the forwarding-only SSH account and the firewall rule are manual steps on the DataHub panel and the box.
