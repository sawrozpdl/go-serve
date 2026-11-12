# सुरक्षण परीक्षण प्रतिवेदन (स्व-घोषणा) — Security self-declaration

*Annex 1 security test report. The IRD office accepted a self-declared test with proper documentation (October 2026). Version under declaration: **{{VERSION}}** (commit {{COMMIT}}).*

## Scope

- Web application and API: authentication, authorisation, input handling, session management.
- Tenant isolation.
- Integrity of fiscal records.
- CBMS credential handling.
- Server and database configuration.
- Backups.

Method: OWASP ASVS level 2 checklist, automated tests, and manual review.

| # | Area | Control | Evidence | Result |
|---|---|---|---|---|
| 1 | Authentication | No passwords stored. Sign-in is Google OAuth or an emailed one-time code, stored hashed and rate-limited per email and per IP. Short-lived access tokens with rotating refresh tokens; global logout | `internal/auth`, OTP rate-limit tests | Pass |
| 2 | Authorisation | Role-based permissions on every route (`fiscal:read/print/correct/manage` for IRD functions; owner-only fiscal switch) | `internal/rbac`, route table | Pass |
| 3 | Tenant isolation | PostgreSQL row-level security on every café table; tests run as the app role | `internal/api` two-pool harness, `test/tenant_isolation_test.go` | Pass |
| 4 | Fiscal immutability | Triggers refuse update and delete for every role. Frozen orders behind invoices. Gap-free sequences | `fiscal_*_test.go`, doc 04, doc 09 | Pass |
| 5 | Audit trail | Append-only and hash-chained; tamper detection tested | `TestAuditChain_DetectsTampering` | Pass |
| 6 | CBMS credentials | AES-256-GCM sealed and bound to the café. Never returned by the API or written to logs. Server refuses to store them without a key | `fiscal/secret.go`, CBMS tests | Pass |
| 7 | Transport | TLS 1.2+ at the edge. The API is reachable only through an encrypted tunnel. Postgres listens on loopback only | `infra/datahub/README.md` | Pass |
| 8 | Server hardening | SSH keys only, one admin IP, no open web ports, automatic security updates, watchdog alerts | {{to confirm on the box}} | ☐ |
| 9 | Backups | Encrypted, WAL archive, monthly restore drill, DR copy in Nepal | doc 05 | ☐ (Nepal DR pending) |
| 10 | Dependencies | `govulncheck`: no vulnerable module calls after the 2026-11-07 upgrades (excelize 2.11.1, chi 5.3.0, x/net 0.62.0, x/text 0.43.0). Standard-library fixes need Go ≥ 1.26.9, which CI and deploy now use. `pnpm audit` still to run: it ran out of memory on this monorepo, so run it per package. | `go run golang.org/x/vuln/cmd/govulncheck ./...` | ☐ (JS audit) |

**Findings and fixes for this version:** {{list here, or "none open"}}.

I declare that the above was tested on the version named, and that the results are true.

Signature: ________________   Name: {{Managing Director}}   Date: {{BS date}}   Company stamp:
