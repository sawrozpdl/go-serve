## What and why

<!-- One or two sentences. -->

## Checks

- [ ] Tests added or updated; `make test` is green locally
- [ ] Migrations add any needed `GRANT … TO app` (tests run as superuser, so a missing grant only fails in the live API)

## IRD e-billing (docs/ird/RELEASES.md)

- [ ] **No fiscal change**: nothing that changes invoices, credit notes, KOTs, prints, CBMS posts, IRD registers or the audit chain
- [ ] **Fiscal change**: `apps/api/internal/version/VERSION` is bumped, `docs/ird/RELEASES.md` has a row with the IRD impact (none / version / re-list), and `docs/ird/COMPLIANCE.md` is updated
