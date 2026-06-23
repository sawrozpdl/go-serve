import { useEffect, useReducer, useRef, useState } from 'react';
import {
  Banknote,
  Landmark,
  Smartphone,
  HandCoins,
  Coffee,
  Bookmark,
  ArrowLeftRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  Receipt,
  TrendingUp,
  TrendingDown,
  Crown,
  PiggyBank,
  Sparkles,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';

import { formatNPR } from '@/components/Money';

// ---------------------------------------------------------------------------
// A hands-on sandbox for "where does the money live, and what moves the
// balance?". Pure client-side — it never touches real data. The numbers and
// the ledger rows each scenario "writes" mirror the actual backend model
// (cash_drops, owner_cash_entries, owner_ledger, house_tab_settlements …) so
// the lesson transfers directly to the real app.
//
// The one idea it exists to teach: moving cash between the cafe's own pockets
// never changes the Cafe balance — only earning or spending does.
// ---------------------------------------------------------------------------

type BucketKey = 'drawer' | 'bank' | 'online' | 'ownerCash';
type Buckets = Record<BucketKey, number>;
type Lenses = {
  tabReceivable: number;
  loansOutstanding: number;
  equityInvested: number;
  payouts: number;
  revenue: number;
  expenses: number;
};

const BUCKET_KEYS: BucketKey[] = ['drawer', 'bank', 'online', 'ownerCash'];
const ZERO_BUCKETS: Buckets = { drawer: 0, bank: 0, online: 0, ownerCash: 0 };
const ZERO_LENSES: Lenses = {
  tabReceivable: 0,
  loansOutstanding: 0,
  equityInvested: 0,
  payouts: 0,
  revenue: 0,
  expenses: 0,
};

/** Rupees → paisa, so amounts read naturally in the scenario table. */
const R = (rupees: number) => rupees * 100;
const total = (b: Buckets) => b.drawer + b.bank + b.online + b.ownerCash;

type FlowEnd = BucketKey | 'in' | 'out';
type GroupId = 'setup' | 'earn' | 'move' | 'spend' | 'capital';

type Scenario = {
  id: string;
  group: GroupId;
  label: string;
  icon: LucideIcon;
  amount: number;
  bucketDeltas?: Partial<Buckets>;
  /** Special case: replaces all bucket balances (the go-live seed). */
  setBuckets?: Buckets;
  lensDeltas?: Partial<Lenses>;
  ledger: string[];
  flow?: { from?: FlowEnd; to?: FlowEnd };
  note: string;
  /** Gate the button on feasibility so balances can never go negative. */
  canApply?: (b: Buckets, l: Lenses) => boolean;
};

const SCENARIOS: Scenario[] = [
  // ---- SET UP ----
  {
    id: 'seed',
    group: 'setup',
    label: 'Seed opening balances',
    icon: Sparkles,
    amount: R(28000),
    setBuckets: { drawer: R(5000), bank: R(20000), online: R(3000), ownerCash: 0 },
    lensDeltas: { equityInvested: R(28000) },
    ledger: [
      `shifts — opening_float +${formatNPR(R(5000))}`,
      `opening cash — bank +${formatNPR(R(20000))} · online +${formatNPR(R(3000))}`,
      `owner_ledger — investment · is_opening +${formatNPR(R(28000))}`,
    ],
    flow: { from: 'in', to: 'bank' },
    note: 'A brand-new cafe starts with what the owners put in. Opening cash sets your drawer, bank and online balances. The matching opening equity is tracked for ROI — but it is NOT re-added to the bank, or the opening cash would be counted twice.',
    canApply: (b) => total(b) === 0,
  },
  // ---- EARN (money comes in) ----
  {
    id: 'sale-cash',
    group: 'earn',
    label: 'Cash sale',
    icon: Coffee,
    amount: R(2000),
    bucketDeltas: { drawer: R(2000) },
    lensDeltas: { revenue: R(2000) },
    ledger: [`orders — status=closed`, `payments — method=cash +${formatNPR(R(2000))}`],
    flow: { from: 'in', to: 'drawer' },
    note: 'A guest pays cash. New money enters the cafe — the drawer and the total both rise by the full amount.',
  },
  {
    id: 'sale-online',
    group: 'earn',
    label: 'Online sale',
    icon: Smartphone,
    amount: R(1500),
    bucketDeltas: { online: R(1500) },
    lensDeltas: { revenue: R(1500) },
    ledger: [`payments — method=online +${formatNPR(R(1500))}`],
    flow: { from: 'in', to: 'online' },
    note: 'Paid by eSewa, Khalti or card. It lands in the online bucket; the total goes up just like a cash sale.',
  },
  {
    id: 'sale-tab',
    group: 'earn',
    label: 'Sale on a house tab',
    icon: Bookmark,
    amount: R(1800),
    lensDeltas: { revenue: R(1800), tabReceivable: R(1800) },
    ledger: [`orders — status=closed`, `house_tabs — balance +${formatNPR(R(1800))}`],
    note: 'The serve counts as Sales — but the guest has not paid yet. It sits in “on tab” (a receivable): real money owed, but not cash on hand, so the balance does not move.',
  },
  {
    id: 'settle-tab-cash',
    group: 'earn',
    label: 'Settle a tab in cash',
    icon: HandCoins,
    amount: R(1800),
    bucketDeltas: { drawer: R(1800) },
    lensDeltas: { tabReceivable: -R(1800) },
    ledger: [`house_tab_settlements — method=cash +${formatNPR(R(1800))}`],
    flow: { from: 'in', to: 'drawer' },
    note: 'The guest clears their tab. The receivable becomes real cash in the drawer — now it counts toward the balance.',
    canApply: (_b, l) => l.tabReceivable >= R(1800),
  },
  // ---- MOVE (between the cafe's own pockets — total never changes) ----
  {
    id: 'owner-take',
    group: 'move',
    label: 'Owner takes cash from the till',
    icon: Crown,
    amount: R(2000),
    bucketDeltas: { drawer: -R(2000), ownerCash: R(2000) },
    ledger: [
      `cash_drops — out · owner_draw ${formatNPR(R(2000))}`,
      `owner_cash_entries — withdrawal ${formatNPR(R(2000))}`,
    ],
    flow: { from: 'drawer', to: 'ownerCash' },
    note: 'The cash left the till — but it is still the cafe’s money, now sitting in “Cash with owners”. Nothing was earned or spent, so the total does not budge. This is exactly why the cafe balance includes owner-held cash.',
    canApply: (b) => b.drawer >= R(2000),
  },
  {
    id: 'owner-deposit',
    group: 'move',
    label: 'Owner banks the held cash',
    icon: ArrowDownToLine,
    amount: R(2000),
    bucketDeltas: { ownerCash: -R(2000), bank: R(2000) },
    ledger: [`owner_cash_entries — bank_deposit ${formatNPR(R(2000))}`],
    flow: { from: 'ownerCash', to: 'bank' },
    note: 'Held cash goes into the bank. Another pure move between the cafe’s own pockets — the total is unchanged.',
    canApply: (b) => b.ownerCash >= R(2000),
  },
  {
    id: 'owner-return',
    group: 'move',
    label: 'Owner returns cash to the till',
    icon: ArrowUpFromLine,
    amount: R(2000),
    bucketDeltas: { ownerCash: -R(2000), drawer: R(2000) },
    ledger: [
      `cash_drops — in · owner_draw ${formatNPR(R(2000))}`,
      `owner_cash_entries — return_to_drawer ${formatNPR(R(2000))}`,
    ],
    flow: { from: 'ownerCash', to: 'drawer' },
    note: 'The owner puts the cash back. It returns to the drawer; across the whole round trip the total never changed.',
    canApply: (b) => b.ownerCash >= R(2000),
  },
  {
    id: 'transfer-deposit',
    group: 'move',
    label: 'Bank the drawer cash',
    icon: ArrowLeftRight,
    amount: R(3000),
    bucketDeltas: { drawer: -R(3000), bank: R(3000) },
    ledger: [
      `account_transfers — cash→bank ${formatNPR(R(3000))}`,
      `cash_drops — out · transfer ${formatNPR(R(3000))}`,
    ],
    flow: { from: 'drawer', to: 'bank' },
    note: 'End-of-day deposit: cash from the till goes to the bank. Still just a move — the total stays put.',
    canApply: (b) => b.drawer >= R(3000),
  },
  // ---- SPEND (money leaves the cafe) ----
  {
    id: 'expense-drawer',
    group: 'spend',
    label: 'Pay an expense from the till',
    icon: Receipt,
    amount: R(1000),
    bucketDeltas: { drawer: -R(1000) },
    lensDeltas: { expenses: R(1000) },
    ledger: [
      `expenses — paid_from=drawer ${formatNPR(R(1000))}`,
      `cash_drops — out · expense ${formatNPR(R(1000))}`,
    ],
    flow: { from: 'drawer', to: 'out' },
    note: 'Cash buys milk. Now money truly leaves the cafe — the drawer and the total both drop.',
    canApply: (b) => b.drawer >= R(1000),
  },
  {
    id: 'expense-bank',
    group: 'spend',
    label: 'Pay an expense from the bank',
    icon: Receipt,
    amount: R(1000),
    bucketDeltas: { bank: -R(1000) },
    lensDeltas: { expenses: R(1000) },
    ledger: [`expenses — paid_from=bank ${formatNPR(R(1000))}`],
    flow: { from: 'bank', to: 'out' },
    note: 'The same purchase, paid by bank transfer. The bank and the total fall together.',
    canApply: (b) => b.bank >= R(1000),
  },
  {
    id: 'owner-spend',
    group: 'spend',
    label: 'Owner spends held cash on the cafe',
    icon: HandCoins,
    amount: R(2000),
    bucketDeltas: { ownerCash: -R(2000) },
    lensDeltas: { expenses: R(2000) },
    ledger: [
      `expenses — paid_from=owner_cash ${formatNPR(R(2000))}`,
      `owner_cash_entries — cafe_expense ${formatNPR(R(2000))}`,
    ],
    flow: { from: 'ownerCash', to: 'out' },
    note: 'The owner uses cash they were holding to buy something for the cafe. That cash is gone now — so the total drops.',
    canApply: (b) => b.ownerCash >= R(2000),
  },
  {
    id: 'owner-loan',
    group: 'spend',
    label: 'Owner covers a bill (loan)',
    icon: PiggyBank,
    amount: R(1200),
    lensDeltas: { expenses: R(1200), loansOutstanding: R(1200) },
    ledger: [
      `expenses — paid_from=owner ${formatNPR(R(1200))}`,
      `owner_ledger — loan_advance ${formatNPR(R(1200))}`,
    ],
    note: 'The owner pays a vendor from their own pocket. The cafe’s cash never moves — yet the expense still counts, and the cafe now owes the owner (a loan).',
  },
  // ---- CAPITAL (owners in & out) ----
  {
    id: 'invest',
    group: 'capital',
    label: 'Owner invests capital',
    icon: TrendingUp,
    amount: R(5000),
    bucketDeltas: { bank: R(5000) },
    lensDeltas: { equityInvested: R(5000) },
    ledger: [`owner_ledger — investment ${formatNPR(R(5000))}`],
    flow: { from: 'in', to: 'bank' },
    note: 'Fresh capital from an owner lands in the bank — the total rises. It is tracked as lifetime invested for ROI, not as income.',
  },
  {
    id: 'payout',
    group: 'capital',
    label: 'Owner payout',
    icon: TrendingDown,
    amount: R(5000),
    bucketDeltas: { bank: -R(5000) },
    lensDeltas: { payouts: R(5000) },
    ledger: [`owner_ledger — payout ${formatNPR(R(5000))}`],
    flow: { from: 'bank', to: 'out' },
    note: 'Profit paid out to an owner. It leaves the bank, so the total drops — but it is a return of capital, not an expense.',
    canApply: (b) => b.bank >= R(5000),
  },
  {
    id: 'repay-loan',
    group: 'capital',
    label: 'Repay an owner loan',
    icon: ArrowUpFromLine,
    amount: R(1200),
    bucketDeltas: { bank: -R(1200) },
    lensDeltas: { loansOutstanding: -R(1200) },
    ledger: [`owner_ledger — loan_repayment ${formatNPR(R(1200))}`],
    flow: { from: 'bank', to: 'out' },
    note: 'The cafe pays the owner back for the bill they covered. Cash leaves the bank — but it is not a new expense (that was already counted).',
    canApply: (b, l) => b.bank >= R(1200) && l.loansOutstanding >= R(1200),
  },
];

const BUCKET_META: { key: BucketKey; label: string; icon: LucideIcon; desc: string }[] = [
  { key: 'drawer', label: 'Drawer', icon: Banknote, desc: 'cash in the till' },
  { key: 'bank', label: 'Bank', icon: Landmark, desc: 'the cafe bank account' },
  { key: 'online', label: 'Online', icon: Smartphone, desc: 'eSewa · Khalti · card' },
  { key: 'ownerCash', label: 'Cash with owners', icon: Crown, desc: 'cafe cash an owner holds' },
];

const GROUPS: { id: GroupId; title: string; hint: string }[] = [
  { id: 'setup', title: 'Set up', hint: 'start here' },
  { id: 'earn', title: 'Earn', hint: 'money comes in → total rises' },
  { id: 'move', title: 'Move cash', hint: 'between the cafe’s own pockets → total never changes' },
  { id: 'spend', title: 'Spend', hint: 'money leaves the cafe → total falls' },
  { id: 'capital', title: 'Capital', hint: 'owners put money in & take it out' },
];

const INTRO_NOTE =
  'Seed the opening balances, then try a scenario. Watch the big number: it only changes when money is earned or spent — never when it merely moves between buckets.';

// ---------------------------------------------------------------------------

function nextBuckets(cur: Buckets, sc: Scenario): Buckets {
  if (sc.setBuckets) return { ...sc.setBuckets };
  const out = { ...cur };
  if (sc.bucketDeltas) {
    (Object.keys(sc.bucketDeltas) as BucketKey[]).forEach((k) => {
      out[k] += sc.bucketDeltas![k]!;
    });
  }
  return out;
}

function nextLenses(cur: Lenses, sc: Scenario): Lenses {
  const out = { ...cur };
  if (sc.lensDeltas) {
    (Object.keys(sc.lensDeltas) as (keyof Lenses)[]).forEach((k) => {
      out[k] += sc.lensDeltas![k]!;
    });
  }
  return out;
}

type LogEntry = { id: number; scenario: string; rows: string[]; totalDelta: number };
type State = {
  buckets: Buckets;
  lenses: Lenses;
  log: LogEntry[];
  seq: number;
  lastScenario: string | null;
};
type Action = { type: 'apply'; scenario: Scenario } | { type: 'reset' };

function reducer(state: State, action: Action): State {
  if (action.type === 'reset') {
    return {
      buckets: { ...ZERO_BUCKETS },
      lenses: { ...ZERO_LENSES },
      log: [],
      seq: state.seq + 1,
      lastScenario: null,
    };
  }
  const sc = action.scenario;
  const buckets = nextBuckets(state.buckets, sc);
  const lenses = nextLenses(state.lenses, sc);
  const delta = total(buckets) - total(state.buckets);
  const entry: LogEntry = { id: state.seq + 1, scenario: sc.label, rows: sc.ledger, totalDelta: delta };
  return {
    buckets,
    lenses,
    log: [entry, ...state.log].slice(0, 10),
    seq: state.seq + 1,
    lastScenario: sc.id,
  };
}

const INITIAL: State = {
  buckets: { ...ZERO_BUCKETS },
  lenses: { ...ZERO_LENSES },
  log: [],
  seq: 0,
  lastScenario: null,
};

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Ease the hero total toward its new value so changes are felt, not just shown. */
function useCountUp(value: number, reduced: boolean) {
  const [display, setDisplay] = useState(value);
  const displayRef = useRef(value);
  useEffect(() => {
    if (reduced) {
      displayRef.current = value;
      setDisplay(value);
      return;
    }
    const from = displayRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const dur = 460;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = Math.round(from + (to - from) * eased);
      displayRef.current = v;
      setDisplay(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced]);
  return display;
}

type Dir = 'up' | 'down';
type Pulse = {
  seq: number;
  total: Dir | 'steady';
  tiles: Partial<Record<BucketKey, { dir: Dir; amt: number }>>;
};
type Chip = { id: number; x: number; y: number; dx: number; dy: number; tone: string; label: string; go: boolean };

export function MoneyFlowSim() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const reduced = usePrefersReducedMotion();
  const grandTotal = total(state.buckets);
  const shownTotal = useCountUp(grandTotal, reduced);

  const stageRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<Record<BucketKey, HTMLDivElement | null>>({
    drawer: null,
    bank: null,
    online: null,
    ownerCash: null,
  });
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const chipId = useRef(0);

  // Clear the flash a beat after each action.
  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(null), 900);
    return () => clearTimeout(t);
  }, [pulse]);

  function pointFor(end: FlowEnd): { x: number; y: number } | null {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return null;
    if (end === 'in') return { x: stage.width / 2, y: -28 };
    if (end === 'out') return { x: stage.width / 2, y: stage.height + 28 };
    const el = tileRefs.current[end];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - stage.left + r.width / 2, y: r.top - stage.top + r.height / 2 };
  }

  function fly(sc: Scenario, delta: number) {
    if (!sc.flow) return;
    const from = sc.flow.from ? pointFor(sc.flow.from) : null;
    const to = sc.flow.to ? pointFor(sc.flow.to) : null;
    if (!from || !to) return;
    const tone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'move';
    const id = ++chipId.current;
    const chip: Chip = {
      id,
      x: from.x,
      y: from.y,
      dx: to.x - from.x,
      dy: to.y - from.y,
      tone,
      label: formatNPR(sc.amount),
      go: false,
    };
    setChips((cs) => [...cs, chip]);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setChips((cs) => cs.map((c) => (c.id === id ? { ...c, go: true } : c)))),
    );
    setTimeout(() => setChips((cs) => cs.filter((c) => c.id !== id)), 900);
  }

  function handleApply(sc: Scenario) {
    const before = state.buckets;
    const after = nextBuckets(before, sc);
    const delta = total(after) - total(before);

    if (!reduced) {
      const tiles: Pulse['tiles'] = {};
      BUCKET_KEYS.forEach((k) => {
        const d = after[k] - before[k];
        if (d !== 0) tiles[k] = { dir: d > 0 ? 'up' : 'down', amt: Math.abs(d) };
      });
      setPulse({ seq: state.seq + 1, total: delta > 0 ? 'up' : delta < 0 ? 'down' : 'steady', tiles });
      fly(sc, delta);
    }
    dispatch({ type: 'apply', scenario: sc });
  }

  const activeNote = state.lastScenario
    ? SCENARIOS.find((s) => s.id === state.lastScenario)?.note ?? INTRO_NOTE
    : INTRO_NOTE;
  const totalDir = pulse?.total ?? 'idle';
  const seeded = grandTotal !== 0 || state.lenses.expenses !== 0 || state.lenses.revenue !== 0;
  const netProfit = state.lenses.revenue - state.lenses.expenses;

  return (
    <div className="mf" ref={stageRef}>
      {/* Hero — the headline number */}
      <div className="mf-hero">
        <div className="mf-hero-main">
          <span className="mf-eyebrow">Cafe balance — cash on hand, right now</span>
          <div className={`mf-total${totalDir !== 'idle' && totalDir !== 'steady' ? ` is-${totalDir}` : ''}`}>
            {formatNPR(shownTotal)}
          </div>
          <div className="mf-formula">drawer + bank + online + cash with owners</div>
        </div>
        <div className="mf-ribbon" data-dir={totalDir} aria-live="polite">
          {totalDir === 'idle' && <span>Make a move →</span>}
          {totalDir === 'up' && <span>▲ earned — total went up</span>}
          {totalDir === 'down' && <span>▼ spent — total went down</span>}
          {totalDir === 'steady' && <span>⟳ money just moved — total unchanged</span>}
        </div>
      </div>

      {/* Bucket tiles */}
      <div className="mf-buckets">
        {BUCKET_META.map((b) => {
          const flash = pulse?.tiles[b.key];
          const Icon = b.icon;
          return (
            <div
              key={b.key}
              ref={(el) => {
                tileRefs.current[b.key] = el;
              }}
              className={`mf-tile${flash ? ` is-${flash.dir}` : ''}`}
            >
              <div className="mf-tile-top">
                <Icon size={15} strokeWidth={1.7} />
                <span>{b.label}</span>
              </div>
              <div className="mf-tile-amt">{formatNPR(state.buckets[b.key])}</div>
              <div className="mf-tile-desc">{b.desc}</div>
              {flash && (
                <span key={pulse!.seq} className={`mf-float is-${flash.dir}`}>
                  {flash.dir === 'up' ? '+' : '−'}
                  {formatNPR(flash.amt)}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Teaching note */}
      <div className="mf-note">{activeNote}</div>

      <div className="mf-main">
        {/* Scenario controls */}
        <div className="mf-controls">
          {GROUPS.map((g) => (
            <div className="mf-group" key={g.id}>
              <div className="mf-group-head">
                <span className="mf-group-title">{g.title}</span>
                <span className="mf-group-hint">{g.hint}</span>
              </div>
              <div className="mf-btns">
                {SCENARIOS.filter((s) => s.group === g.id).map((s) => {
                  const ok = s.canApply ? s.canApply(state.buckets, state.lenses) : true;
                  const Icon = s.icon;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`mf-btn ${g.id}`}
                      disabled={!ok}
                      onClick={() => handleApply(s)}
                      title={ok ? undefined : s.id === 'seed' ? 'Already seeded — Reset to start over' : 'Not enough in that bucket yet'}
                    >
                      <Icon size={15} strokeWidth={1.7} />
                      <span className="mf-btn-label">{s.label}</span>
                      <span className="mf-btn-amt">{formatNPR(s.amount)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Side panels */}
        <aside className="mf-side">
          <div className="mf-panel">
            <h3>Not in the balance</h3>
            <p className="mf-panel-sub">Real money — but not cash on hand, so it sits outside the cafe balance.</p>
            <div className="mf-lens">
              <span className="mf-lens-label">On tab (guests owe)</span>
              <span className="mf-lens-amt">{formatNPR(state.lenses.tabReceivable)}</span>
            </div>
            <div className="mf-lens">
              <span className="mf-lens-label">Owed to owners (loans)</span>
              <span className="mf-lens-amt">{formatNPR(state.lenses.loansOutstanding)}</span>
            </div>
          </div>

          <div className="mf-panel">
            <h3>Other lenses</h3>
            <p className="mf-panel-sub">Capital & earnings — separate from “how much cash is here”.</p>
            <div className="mf-lens">
              <span className="mf-lens-label">Lifetime invested</span>
              <span className="mf-lens-amt">{formatNPR(state.lenses.equityInvested)}</span>
            </div>
            <div className="mf-lens">
              <span className="mf-lens-label">Paid out to owners</span>
              <span className="mf-lens-amt">{formatNPR(state.lenses.payouts)}</span>
            </div>
            <div className="mf-lens">
              <span className="mf-lens-label">Sales (revenue)</span>
              <span className="mf-lens-amt">{formatNPR(state.lenses.revenue)}</span>
            </div>
            <div className="mf-lens">
              <span className="mf-lens-label">Expenses</span>
              <span className="mf-lens-amt">{formatNPR(state.lenses.expenses)}</span>
            </div>
            <div className="mf-lens mf-lens--strong">
              <span className="mf-lens-label">Net (sales − expenses)</span>
              <span className={`mf-lens-amt${netProfit < 0 ? ' is-down' : netProfit > 0 ? ' is-up' : ''}`}>
                {formatNPR(netProfit)}
              </span>
            </div>
          </div>

          <div className="mf-panel">
            <h3>Ledger — what each action writes</h3>
            {state.log.length === 0 ? (
              <p className="mf-empty">Click a scenario to see the exact rows it would write to the database.</p>
            ) : (
              <div className="mf-log">
                {state.log.map((e) => (
                  <div className="mf-log-row" key={e.id}>
                    <div className="mf-log-head">
                      <span className="mf-log-name">{e.scenario}</span>
                      <span
                        className={`mf-delta is-${
                          e.totalDelta > 0 ? 'up' : e.totalDelta < 0 ? 'down' : 'steady'
                        }`}
                      >
                        {e.totalDelta === 0
                          ? 'total unchanged'
                          : `${e.totalDelta > 0 ? '+' : '−'}${formatNPR(Math.abs(e.totalDelta))}`}
                      </span>
                    </div>
                    <ul>
                      {e.rows.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      <div className="mf-toolbar">
        <button type="button" className="btn" onClick={() => dispatch({ type: 'reset' })}>
          <RotateCcw size={14} strokeWidth={1.8} /> {seeded ? 'Reset' : 'Clear'}
        </button>
        <span className="mf-toolbar-note">A sandbox — nothing here touches your real data.</span>
      </div>

      {/* Flying-money overlay */}
      <div className="mf-chips" aria-hidden="true">
        {chips.map((c) => (
          <span
            key={c.id}
            className={`mf-chip is-${c.tone}${c.go ? ' go' : ''}`}
            style={{
              left: c.x,
              top: c.y,
              transform: c.go ? `translate(${c.dx}px, ${c.dy}px)` : 'translate(0, 0)',
            }}
          >
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
