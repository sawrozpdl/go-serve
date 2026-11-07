# प्रणालीको संरचना — System architecture

```
 Café staff (browser / Android app)
        │ HTTPS (TLS 1.2+)
        ▼
 Cloudflare edge ══ encrypted tunnel (outbound only; no open web ports) ══╗
                                                                         ▼
                              ┌──────────── Server in Nepal ({{data centre}}, Kathmandu) ────────────┐
                              │  Go API (systemd)  ──►  PostgreSQL 18 (row-level security per café) │
                              │       │                   ├─ fiscal tables (immutable, triggers)     │
                              │       │                   ├─ hash-chained activity log               │
                              │       │                   └─ IRD views (Standard View, registers)    │
                              │       └─► CBMS worker ──HTTPS──► IRD CBMS  (cbapi.ird.gov.np)        │
                              │  pgBackRest / restic ──► encrypted backups: DR site in Nepal (+ copy)│
                              └──────────────────────────────────────────────────────────────────────┘
```

- **Multi-tenancy (§7.2(ग)).** One database. Every café's rows carry its `tenant_id`, and PostgreSQL row-level security policies confine each request to one café: the session's `app.tenant_id` is set per transaction. Isolation is covered by automated tests that run as the application's own database role.
- **Issuing a bill.** Settle → the server takes the next number in the café's fiscal-year series → writes the immutable invoice and its CBMS outbox entry in the same transaction → the CBMS worker posts it within seconds. If IRD is unreachable it retries with backoff and marks the bill non-real-time.
- **Numbering.** `[outlet code-]n` restarts at 1 on 1 Shrawan in each fiscal year (Bikram Sambat calendar, Nepal time). Order slips (KOT-n), sales returns (CN-n), reverse entries (RE-n) and purchase returns (PR-n) each have their own series.
- **Printing.** The server decides every copy's label (TAX INVOICE → INVOICE (seller's copy) → Copy of Original (n)) and logs each print. The web app prints through the browser. The Android app prints ESC/POS directly to a LAN thermal printer, with a native QR code.
- **IRD access (§11).** Per-visit, per-café, time-limited read-only database logins (`docs/ird/IRD_ACCESS.md`). Every register can also be downloaded from the app as Excel, CSV, XML or PDF.
- **Front end.** Static files delivered over a CDN. The CDN holds no taxpayer data; all data is on the server in Nepal.
