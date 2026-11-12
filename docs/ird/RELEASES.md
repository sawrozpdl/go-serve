# Go Serve releases: IRD compliance log

IRD lists billing software by **name and version** (procedure 2082 §3(घ)):
- **A version change** (same name, front end and/or back end changed) needs an updated security test report and a criteria certification on the Taxpayer Portal.
- **A change of main features, technology and name** needs a fresh listing (Annex 1).

The listed version is the API's `apps/api/internal/version/VERSION`. It is shown on `/healthz`, on `/me` (`server_version`), on every printed invoice and in the web app's version chip.

## Rules

1. **A fiscal change is any change to:**
   - `apps/api/internal/fiscal/**`;
   - a `fiscal_*`, `cbms_*`, `credit_notes`, `purchase_bills`, `ird_*` or `audit_log`-chain migration;
   - `packages/receipt-format/**`;
   - the web invoice, credit-note or register renderers (`apps/web/src/lib/invoicePrint.ts`, `pages/admin/fiscal/**`);
   - anything that changes what an invoice, register or CBMS post contains.
2. Every PR states whether it makes a fiscal change (see the PR template). CI (`scripts/ird/check-fiscal-change.sh`) lists the fiscal files a PR touches. From **1.0.0** on, CI fails a fiscal change that does not bump `VERSION`.
3. A fiscal change ships as a new version, and its row below says what IRD needs:
   - `none`: internal only, nothing IRD reviewed changed;
   - `version`: update the security report and the Taxpayer Portal entry;
   - `re-list`: name, technology or main features changed; file a new Annex 1.
4. Cafés in fiscal mode are told before a `version` or `re-list` release goes live.

## Log

| Version | Date (AD / BS) | Commit | Fiscal change | IRD impact | Notes |
|---|---|---|---|---|---|
| 0.9.0 | 2026-11-07 / 2083-07-21 | (branch `ird-compliance`) | yes | none: pre-listing | IRD e-billing built (P0–P8); not yet listed |
| 0.9.0 | 2026-11-08 / 2083-07-22 | (branch `ird-compliance`) | yes | none: pre-listing | Mobile parity: buyer at settle, corrections and credit-note printing, KOT number on kitchen tickets (web + mobile) |
| 1.0.0 | — | — | — | listing | Freeze after: Nepal DR copy, IRD meeting answers (Q1–Q10), security self-declaration (doc 07), sample set on the CBMS test server |
