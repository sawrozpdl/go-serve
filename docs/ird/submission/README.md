# IRD submission documents (index; not submitted itself)

This folder holds the documents a café's permit application (Annex 3 §6) and the IRD office checklist ask for. Each one describes Go Serve **as built**. Check each against production, then print, sign and stamp.

| File | Office checklist item | Annex 3 §6 |
|---|---|---|
| `04-data-integrity.md` | 4: how data is kept from being changed | (ग) |
| `05-backup-recovery.md` | 5: backup and recovery arrangement | (घ) |
| `06-system-architecture.md` | 6: system architecture | (ङ) |
| `07-security-self-declaration.md` | Annex 1 security test report (the office accepted a self-declared test, Oct 2026) | — |
| `08-server-system-information.md` | 11(ज): server MAC and system information | — |
| `09-delete-refusal.md` | 11(झ): the message shown when deleting from the master sales table | — |

The pre-filled forms (Annex 1, 2, 3, 7 and 8, plus the letters) are generated in the app:
- Settings → Tax & IRD → IRD documents (per café);
- /super/ird (Annex 1).

The sample set (prints 1–4 of a bill, the registers, credit notes, reverse entry and audit trail) is produced by `apps/api/cmd/irdsample`.

**Before anyone signs:**
- [ ] Production version matches the one named in 07 (`/healthz` reports `version`).
- [ ] 08 regenerated on the production box (`infra/datahub/sysinfo.sh`).
- [ ] 09 regenerated against production (`scripts/ird/delete-refusal.sh`).
- [ ] The Nepal DR copy exists and its address is in /super/ird (`docs/ird/OPERATIONS.md` §1).
- [ ] The values in /super/ird match the producer's registration documents.
