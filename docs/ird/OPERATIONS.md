# IRD operations runbook

This runbook covers the operational duties that the electronic billing procedure places on the producer and the server operator. The infrastructure itself is described in `infra/datahub/README.md`.

| Duty | Clause | Status |
|---|---|---|
| Relational DB with log archive enabled; backups on a separate device, recoverable | 2082 §6.1(ग); 2074 §6(ग) | ✅ WAL archiving and backups via pgBackRest. 🟡 **A second copy in Nepal is still to be set up** (§1 below). |
| DB and log backup for each fiscal year, kept for the statutory period | §8(च); 2074 §8(घ) | 🟡 Continuous backups are kept. A sealed fiscal-year archive is in §3. |
| Server in Nepal, IRD told in advance | §7.2(क)(ख) | ✅ DataHub, Kathmandu. Each café sends the server-location notice (P8). |
| Temporary server when the main one is down, with approval, number series unbroken | §7.2(च) | 🟡 Runbook in §4. A rehearsal still needs to be done and recorded. |
| Closing a café's permit | §10, Annex 8/9 | ✅ Procedure in §5 |
| IRD access | §11 | ✅ `docs/ird/IRD_ACCESS.md` |

## 1. Backups and the Nepal DR copy

Today, pgBackRest (WAL plus weekly full and daily differential backups) and restic (uploads) write to `gs://goserve-backups-hearth` in GCP asia-south1. That is outside Nepal. It is kept as an extra *encrypted* copy (open question Q6). **For the IRD application and Annex 7, a second copy inside Nepal is required** and is named as the DR site.

Plan:
1. Buy object storage (S3-compatible) or a small VM disk at a second Nepali location, either a second DataHub data centre or another Nepal-registered provider. Record its address; it is the **DR Site Address** on Annex 7.
2. Add it to pgBackRest as `repo2`. Archives are pushed to every repo, so WAL reaches both:
   ```ini
   repo2-type=s3
   repo2-s3-endpoint=<nepal endpoint>
   repo2-s3-bucket=goserve-dr
   repo2-path=/pgbackrest
   repo2-cipher-type=aes-256-cbc
   repo2-retention-full=8
   ```
   Then run `sudo -u postgres pgbackrest --stanza=goserve stanza-create` and take a full backup with `--repo=2`.
3. Point a second restic repository at it for `/data/uploads`, using the same timer.
4. Run a restore drill **from repo2** (§2) and record it.

## 2. Restore drills

Run one monthly, and after any backup change. Restore into a scratch directory, start it on another port, compare row counts of the fiscal tables, run `audit_chain_verify` for each fiscal café, then delete the scratch copy.

```bash
sudo -u postgres pgbackrest --stanza=goserve --repo=2 --pg1-path=/data/drill restore
sudo -u postgres pg_ctl -D /data/drill -o "-p 5499" start
psql -p 5499 goserve -c "SELECT count(*) FROM invoices; SELECT count(*) FROM credit_notes; SELECT count(*) FROM audit_log;"
```

**Drill log** (append one line per drill):

| Date (AD / BS) | Repo | Point in time | Fiscal row counts match | Chains verify | By |
|---|---|---|---|---|---|
| 2026-11-04 | repo1 (GCS) | latest | ✅ (pre-fiscal) | n/a | — |

## 3. Fiscal-year archive

About 30 days after the last day of Asar, when late corrections have settled, do this for each fiscal café:
1. Download its records archive for the closed year (Settings → Tax & IRD → Download all records, choosing the year with the `?fy=` parameter).
2. Store the zip, and its `manifest.json` SHA-256, in **both** backup repositories under `fy-archives/<slug>/<fy>/`.
3. Record the archive's SHA-256 in that café's audit trail with a note, so the chain covers it.
4. Keep it for the statutory record period. **Never delete it.**

*(A worker that seals these automatically is planned; until then this is a checklist item for the start of each Bhadra.)*

## 4. Temporary server (§7.2(च))

Use this when the DataHub box is unreachable for longer than a café can wait.

1. **First, the café asks its tax office for approval.** The temporary-server request letter is generated in Settings → Tax & IRD → Documents (P8). Do not bill from a temporary server without approval.
2. Restore the latest point in time onto a standby box in Nepal, ideally the DR location from §1: pgBackRest `restore`, `restic restore`, then install the same API release.
3. Point the Cloudflare tunnel at the standby by moving the tunnel token. URLs do not change.
4. Numbering continues unbroken because the sequences (`fiscal_sequences`) are part of the restored database. **Never start a temporary server from an empty database.**
5. Bills issued while CBMS was unreachable sit in the outbox and post when it is back, marked non-real-time.
6. When the main server is back, restore the standby's database onto it, or keep the standby as the new primary. Never run both at once. Tell the tax office the dates.

Rehearse this once and record the result here.

## 5. Closing a café (§10, Annex 8)

1. The café files Annex 8 with its tax office; the generator is in P8.
2. In the super console, set the café's billing state to **write-locked**. No new bills can be issued. Reads, reprints, registers and the records archive keep working.
3. Give the café its final records archive.
4. **Never purge a fiscal café.** The database refuses anyway: fiscal tables `RESTRICT` deletes, and the console answers `fiscal_tenant`. IRD may ask for the data after the café has gone (§11(च)).

## 6. Recurring

- **Every Chaitra:** run the BS calendar check (`docs/ird/COMPLIANCE.md` → Recurring checks).
- **Every release:** bump the version, update the release log, and assess compliance impact (P9).
- **Monthly:** run a restore drill (§2), check `ird-access.sh list` for stale grants, and check the CBMS backlog (Reports → IRD registers → CBMS status).
