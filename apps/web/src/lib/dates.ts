// Local-calendar ISO date helpers (YYYY-MM-DD). Shared by the day-steppers on
// History and Profitability. All arithmetic is done in local time so a date
// picked at 23:00 NPT — or one that crosses a DST/month boundary — never lands
// on the wrong calendar day (the classic UTC off-by-one trap).

export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Step an ISO date by whole days using local-calendar arithmetic (not UTC).
export function addDaysIso(iso: string, delta: number): string {
  const dt = new Date(`${iso}T00:00:00`);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function yesterdayIso(): string {
  return addDaysIso(todayIso(), -1);
}
