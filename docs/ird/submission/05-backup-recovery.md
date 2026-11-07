# ब्याकअप तथा पुनर्स्थापना व्यवस्था — Backup and recovery

*Procedure 2082 §6.1(ग), §7.2(च), §8(च); 2074 §6(ग)(ड), §8(घ).*

| What | How | How often |
|---|---|---|
| Database transaction log (WAL, "log archive") | pgBackRest `archive-push`, giving point-in-time recovery | Continuous (within 5 minutes) |
| Full database backup | pgBackRest | Weekly |
| Differential backup | pgBackRest | Daily |
| Uploaded files | restic | Daily (keeps 14 daily, 8 weekly, 12 monthly) |
| A café's complete records | "Download all records" in the app: zip of all tables as CSV, the registers in Excel, and a SHA-256 manifest | On demand; sealed per fiscal year (§3) |

**Where backups are kept.** Backups are encrypted (AES-256) and kept on a separate device from the database server:
- **repo 1:** object storage *(outside Nepal; kept as an extra encrypted copy)*;
- **repo 2:** DR site in Nepal, at {{DR site address}}.

**Fiscal-year archive.** One month after each fiscal year closes, each café's records archive for that year is written to both repositories and its SHA-256 is recorded in the café's activity log. It is kept for the statutory period and never deleted.

**Recovery.** Restore to any point in time with pgBackRest. Restore drills run monthly and are logged in `docs/ird/OPERATIONS.md` §2: last drill {{date}}, all fiscal row counts matched, and the hash chains verified.

**Temporary server (§7.2(च)).** With the tax office's approval, the latest point in time is restored onto a standby server in Nepal. Bill numbers continue unbroken because the number series are stored in the database. Bills issued while CBMS is unreachable are reported as soon as it returns, flagged as not real-time. The runbook is in `docs/ird/OPERATIONS.md` §4.
