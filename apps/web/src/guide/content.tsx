import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Compass,
  LayoutGrid,
  ChefHat,
  CreditCard,
  Wallet,
  Crown,
  Receipt,
  Calculator,
  Boxes,
  Users,
  Settings as SettingsIcon,
  WifiOff,
  BookOpen,
  HelpCircle,
  ArrowRight,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { EXPLAINERS } from './explainers';
import { Collapsible } from '@/components/Collapsible';
import { AnnotatedShot } from '@/components/AnnotatedShot';

export type GuideSection = {
  /** Unique anchor across the whole guide (used for deep links). */
  id: string;
  heading: string;
  body: ReactNode;
  /** If set, the section offers a "Start walkthrough" button for this tour id. */
  tour?: string;
};

export type GuideTopic = {
  id: string;
  title: string;
  icon: LucideIcon;
  /** One-liner for the rail and search. */
  blurb: string;
  sections: GuideSection[];
};

/** Inline "jump into the real screen" button. */
function TryIt({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="guide-tryit" to={to}>
      {children} <ArrowRight size={13} strokeWidth={1.8} aria-hidden />
    </Link>
  );
}

export const GUIDE_TOPICS: GuideTopic[] = [
  {
    id: 'welcome',
    title: 'Welcome to GoServe',
    icon: Compass,
    blurb: 'The big picture and how to use this guide.',
    sections: [
      {
        id: 'welcome-flow',
        heading: 'How a day flows',
        tour: 'first-serve',
        body: (
          <>
            <p>
              GoServe runs your cafe end-to-end. The core loop is simple, and everything
              else (reports, money, stock) flows from it:
            </p>
            <ol className="guide-steps">
              <li><strong>Open a shift</strong> so the cash drawer is live.</li>
              <li><strong>Take orders on the Floor</strong> — a “serve” is one table’s tab or a walk-in.</li>
              <li><strong>Send</strong> items to the Kitchen display / printer.</li>
              <li><strong>Settle</strong> when the guest pays (cash, online, or house tab).</li>
              <li><strong>Close the shift</strong> and count the drawer at the end.</li>
            </ol>
            <p>
              A serve only counts toward Sales and History once it’s <strong>settled
              (closed)</strong> — that single fact explains most of how the numbers behave.
            </p>
            <TryIt to="/admin/floor">Open the Floor</TryIt>
          </>
        ),
      },
      {
        id: 'welcome-using',
        heading: 'Using this guide',
        body: (
          <>
            <p>
              Pick a topic on the left, or search. Anywhere you see an{' '}
              <strong>ⓘ</strong> next to a number in the app, hover it for a quick
              explanation and a “Learn more →” link straight into the matching section
              here. The walkthroughs (look for <em>Start walkthrough</em>) spotlight the
              real screens step by step.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: 'floor',
    title: 'Taking orders (Floor)',
    icon: LayoutGrid,
    blurb: 'Tables, walk-ins, items, splitting and discounts.',
    sections: [
      {
        id: 'floor-basics',
        heading: 'Tables & walk-ins',
        body: (
          <>
            <p>
              The Floor shows every table at a glance. Tap a free table to start a serve;
              tap a running one to open its tab. For takeaway with no table, use a{' '}
              <strong>Walk-in</strong> tile.
            </p>
            <AnnotatedShot
              src="/guide/floor.webp"
              alt="The Floor screen"
              caption="The floor map — tap a tile to open or resume a serve."
              pins={[
                { x: 27, y: 24, label: 'A running serve — the open total, item count and what’s cooking' },
                { x: 42, y: 24, label: 'A free table — tap to start a serve' },
                { x: 27, y: 66, label: 'Walk-in / Unknown — a takeaway tab with no table' },
              ]}
            />
            <TryIt to="/admin/floor">Open the Floor</TryIt>
          </>
        ),
      },
      {
        id: 'floor-items',
        heading: 'Adding items, splitting & discounts',
        body: (
          <>
            <p>
              On a tab, add menu items, adjust quantities, and apply a discount if needed.
              You can split a bill or move items between tabs before settling.
            </p>
            <Collapsible title="Voiding an item">
              <p>
                Voiding removes an item from a serve and is recorded in the Activity log.
                On an already-closed serve the total doesn’t change — voids are tracked for
                oversight, not to rewrite history.
              </p>
            </Collapsible>
          </>
        ),
      },
    ],
  },
  {
    id: 'kitchen',
    title: 'The Kitchen display',
    icon: ChefHat,
    blurb: 'Tickets, auto-ready items and bumping.',
    sections: [
      {
        id: 'kitchen-tickets',
        heading: 'Tickets & bumping',
        body: (
          <>
            <p>
              When you <strong>Send</strong> items, they appear as a ticket on the Kitchen
              display (and print a docket if printing is on). Kitchen staff bump items as
              they’re made; a finished serve clears from the board.
            </p>
            <p>
              Menu items marked <strong>auto-ready</strong> (e.g. a bottled drink) skip the
              kitchen entirely — they’re ready the moment they’re sent.
            </p>
            <AnnotatedShot
              src="/guide/kitchen.webp"
              alt="The Kitchen display"
              caption="Sent items become tickets; bump each one as it’s made."
              pins={[
                { x: 29, y: 30, label: 'A ticket — what a table sent, with any kitchen notes' },
                { x: 29, y: 37, label: 'Mark ready to bump an item once it’s made' },
                { x: 68, y: 30, label: 'Ready — done and waiting to be served' },
              ]}
            />
            <TryIt to="/admin/kitchen">Open the Kitchen display</TryIt>
          </>
        ),
      },
    ],
  },
  {
    id: 'settle',
    title: 'Settling & payments',
    icon: CreditCard,
    blurb: 'Cash, online, house tabs and combined settle.',
    sections: [
      {
        id: 'settle-methods',
        heading: 'How to settle',
        body: (
          <>
            <p>
              Settling closes a serve and records how it was paid:
            </p>
            <ul>
              <li><strong>Cash</strong> — lands in the open shift’s drawer.</li>
              <li><strong>Online</strong> — eSewa, Khalti, card and other digital channels.</li>
              <li><strong>House tab</strong> — bill a regular’s running tab; recorded as a sale, but the cash isn’t in hand until the tab is settled.</li>
            </ul>
            <p>
              You can split one bill across methods (combined settle). Cash payments
              require an <strong>open shift</strong> — if cash is blocked, open a shift
              first.
            </p>
            <AnnotatedShot
              src="/guide/settle.webp"
              alt="The settle dialog"
              caption="Settling closes a serve and records how it was paid."
              pins={[
                { x: 50, y: 38, label: 'The bill total and the balance still owed' },
                { x: 50, y: 51, label: 'Edit the amount to split one bill across methods' },
                { x: 38, y: 68, label: 'Cash, Online, or House tab (collect later)' },
              ]}
            />
            <TryIt to="/admin/history">See settled serves in History</TryIt>
          </>
        ),
      },
    ],
  },
  {
    id: 'shifts',
    title: 'Cash drawer & shifts',
    icon: Wallet,
    blurb: 'Open, drops, close and variance.',
    sections: [
      {
        id: 'shifts-run',
        heading: 'Running a shift',
        tour: 'close-shift',
        body: (
          <>
            <p>
              A shift tracks the physical cash drawer. Open one with your starting{' '}
              <strong>float</strong>; cash payments are blocked until you do. During the
              shift you can record cash drops in/out.
            </p>
            <p>
              At close, count the drawer. GoServe compares your count to what it expected
              (float + cash sales − drops) and stamps the <strong>variance</strong>. Because
              that variance is locked in, you can’t delete cash entries from a closed shift —
              record a correction in the current shift instead.
            </p>
            <AnnotatedShot
              src="/guide/shift.webp"
              alt="The Shift screen"
              caption="A shift tracks the physical cash drawer."
              pins={[
                { x: 53, y: 38, label: 'Expected cash = float + cash sales − drops' },
                { x: 39, y: 66, label: 'Count the drawer at close — the gap is the variance' },
                { x: 88, y: 34, label: 'Past shifts — matched, or the variance flagged' },
              ]}
            />
            <TryIt to="/admin/shift">Open Shift</TryIt>
          </>
        ),
      },
    ],
  },
  {
    id: 'owners',
    title: 'Owners & cash custody',
    icon: Crown,
    blurb: 'When an owner takes cafe cash, and how to clear it.',
    sections: [
      {
        id: 'owners-custody',
        heading: 'Cash with owners',
        body: (
          <>
            <p>
              When an owner takes cash from the till, it doesn’t disappear — it moves to a
              holding bucket, <strong>Cash with owners</strong>, that’s still part of the
              cafe balance. Clear each holding one of three ways:
            </p>
            <ul>
              <li><strong>Deposit to bank</strong> — moves it from the owner to the bank.</li>
              <li><strong>Spend on cafe</strong> — records a cafe expense paid from that cash.</li>
              <li><strong>Return to drawer</strong> — puts it back in the till.</li>
            </ul>
            <p>
              A “Spent on cafe” movement is just the custody side of an expense. To undo it,
              delete the linked expense — the movement and balance update automatically.
            </p>
            <AnnotatedShot
              src="/guide/owners.webp"
              alt="The Owners screen"
              caption="Owners, their equity, and cash custody."
              pins={[
                { x: 43, y: 33, label: 'Cash with owners — clear cash an owner took from the till' },
                { x: 33, y: 53, label: 'Each owner’s shares and equity stake' },
              ]}
            />
            <TryIt to="/admin/owners">Open Owners</TryIt>
          </>
        ),
      },
    ],
  },
  {
    id: 'expenses',
    title: 'Expenses & where money goes',
    icon: Receipt,
    blurb: 'Sources, categories and allocating to the menu.',
    sections: [
      {
        id: 'expenses-basics',
        heading: 'Recording expenses',
        body: (
          <>
            <p>
              Log every outgoing — supplies, rent, salary — with what it was for and how it
              was paid (drawer, bank, or owner cash). Expenses land in a period by their{' '}
              <strong>paid date</strong>.
            </p>
            <AnnotatedShot
              src="/guide/expenses.webp"
              alt="The Expenses screen"
              caption="Every outgoing — what it was for and how it was paid."
              pins={[
                { x: 91, y: 8, label: 'Log a new expense' },
                { x: 30, y: 18, label: 'Filter by category, payment source, or date' },
                { x: 63, y: 49, label: 'Paid from — drawer, bank, or owner cash' },
              ]}
            />
            <Collapsible title="Allocating an expense to menu categories">
              <p>
                Optionally split an expense across menu categories (e.g. “5kg flour →
                Momos”). Allocations feed the <em>category gross-margin</em> view on the
                Profitability page. Expenses you don’t allocate still count toward Net
                profit — they’re just shown as unallocated overhead.
              </p>
            </Collapsible>
            <TryIt to="/admin/expenses">Open Expenses</TryIt>
          </>
        ),
      },
    ],
  },
  {
    id: 'numbers',
    title: 'Your numbers explained',
    icon: Calculator,
    blurb: 'Exactly how every figure is calculated.',
    sections: [
      {
        id: 'numbers-intro',
        heading: 'How to read the reports',
        tour: 'dashboard',
        body: (
          <>
            <p>
              Two ideas explain almost everything: sales-side numbers are placed in a period
              by a serve’s <strong>close (settle) time</strong> in your cafe’s timezone;
              expense-side numbers by their <strong>paid date</strong>. Below, every metric
              spelled out — these are the same explanations behind each ⓘ in the app.
            </p>
            <AnnotatedShot
              src="/guide/dashboard.webp"
              alt="The Dashboard"
              caption="Headline numbers for the period you pick."
              pins={[
                { x: 46, y: 8, label: 'Pick the period — Today, 7 days, this month…' },
                { x: 27, y: 56, label: 'Cafe balance, sales, orders and net profit' },
                { x: 46, y: 70, label: 'Daily sales — serves bucketed by close time' },
              ]}
            />
          </>
        ),
      },
      // Single source of truth: generate one section per metric explainer.
      ...EXPLAINERS.map((e) => ({ id: e.anchor, heading: e.label, body: e.how })),
    ],
  },
  {
    id: 'inventory',
    title: 'Inventory & stock',
    icon: Boxes,
    blurb: 'Tracking stock and low-stock alerts.',
    sections: [
      {
        id: 'inventory-basics',
        heading: 'Stock tracking',
        body: (
          <>
            <p>
              Track retail items and ingredients, link them to menu items so sales draw down
              stock, and watch the low-stock alert on the dashboard. Restocks are logged as
              expenses so money and stock stay in step.
            </p>
            <AnnotatedShot
              src="/guide/inventory.webp"
              alt="The Inventory screen"
              caption="Stock levels for retail items and ingredients."
              pins={[
                { x: 83, y: 8, label: 'How many items are low on stock right now' },
                { x: 52, y: 24, label: 'On-hand quantity against the par-low threshold' },
                { x: 78, y: 24, label: 'LOW once stock dips below par' },
              ]}
            />
            <TryIt to="/admin/inventory">Open Inventory</TryIt>
          </>
        ),
      },
    ],
  },
  {
    id: 'staff',
    title: 'Staff & scheduling',
    icon: Users,
    blurb: 'Roster, roles, documents and the timeline.',
    sections: [
      {
        id: 'staff-basics',
        heading: 'Team, staff & roles',
        body: (
          <>
            <p>
              <strong>Team</strong> manages who can log in and what they can do (roles +
              permissions). <strong>Staff</strong> is the people registry — schedules,
              shifts on the timeline, and private documents. What each person sees in GoServe
              is controlled by their role.
            </p>
            <AnnotatedShot
              src="/guide/staff.webp"
              alt="The Staff screen"
              caption="The people registry — roster and shift timeline."
              pins={[
                { x: 32, y: 16, label: 'Switch to the Timeline to plan shifts' },
                { x: 28, y: 34, label: 'Each person — role, status and private documents' },
              ]}
            />
            <TryIt to="/admin/staff">Open Staff</TryIt>
          </>
        ),
      },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    icon: SettingsIcon,
    blurb: 'Hours, printing, tax, branding and privacy.',
    sections: [
      {
        id: 'settings-basics',
        heading: 'Configuring your cafe',
        body: (
          <>
            <p>
              Settings holds your identity and branding, opening hours, workflow toggles
              (auto-serve, combined settle), printing, locale &amp; tax (VAT mode), and
              privacy/data controls. Most reporting behaviour (timezone, VAT) comes from
              here, so it’s worth getting right early.
            </p>
            <AnnotatedShot
              src="/guide/settings.webp"
              alt="The Settings screen"
              caption="Everything that shapes your cafe and its reports."
              pins={[
                { x: 50, y: 17, label: 'Tabs for hours, workflow, printing and more' },
                { x: 75, y: 17, label: 'Locale & tax — timezone and VAT mode' },
                { x: 47, y: 42, label: 'Identity & branding — name and logo' },
              ]}
            />
            <TryIt to="/admin/settings">Open Settings</TryIt>
          </>
        ),
      },
    ],
  },
  {
    id: 'offline',
    title: 'Offline mode',
    icon: WifiOff,
    blurb: 'Keep serving when the internet drops.',
    sections: [
      {
        id: 'offline-basics',
        heading: 'Working offline',
        body: (
          <>
            <p>
              GoServe keeps working if the connection drops — you can keep taking and settling
              serves. Writes are queued and sync when you’re back online; order writes are
              idempotent so nothing double-posts, and a sync review tray flags anything that
              needs a look.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: 'glossary',
    title: 'Glossary',
    icon: BookOpen,
    blurb: 'Plain-English definitions of GoServe terms.',
    sections: [
      {
        id: 'glossary-terms',
        heading: 'Key terms',
        body: (
          <dl className="guide-glossary">
            <dt>Serve</dt>
            <dd>One settled order — a table’s bill or a walk-in. Counts once closed.</dd>
            <dt>Close / settle</dt>
            <dd>Taking payment and finishing a serve. This is when it hits Sales and History.</dd>
            <dt>House tab</dt>
            <dd>A regular’s running credit tab. A sale recorded now, cash collected later.</dd>
            <dt>On tab (not in hand)</dt>
            <dd>The portion of sales billed to house tabs and not yet collected.</dd>
            <dt>Cash with owners</dt>
            <dd>Cafe cash an owner has taken but not yet reconciled. Still cafe money.</dd>
            <dt>Direct cost (COGS)</dt>
            <dd>The per-unit cost set on a menu item, captured at the time of sale.</dd>
            <dt>Allocated cost</dt>
            <dd>The slice of an expense you’ve tagged to a menu category.</dd>
            <dt>Gross margin</dt>
            <dd>Revenue − (direct + allocated cost), per category. A pricing lens.</dd>
            <dt>Net profit</dt>
            <dd>Sales − all expenses for the period. The cash bottom line.</dd>
            <dt>Variance</dt>
            <dd>The difference between the counted drawer and what GoServe expected at close.</dd>
          </dl>
        ),
      },
    ],
  },
  {
    id: 'faq',
    title: 'FAQ',
    icon: HelpCircle,
    blurb: 'Quick answers to common questions.',
    sections: [
      {
        id: 'faq-list',
        heading: 'Common questions',
        body: (
          <>
            <Collapsible title="Why don’t my Profitability margins match Net profit?">
              <p>
                They’re different lenses. Category gross margin only counts costs you’ve
                attributed to a category (per-unit cost + allocations). Net profit counts{' '}
                <em>every</em> expense for the period. See{' '}
                <Link to="/admin/guide#metric-profit-net">Net profit</Link>.
              </p>
            </Collapsible>
            <Collapsible title="Why does ‘Peak hours’ look later than our rush?">
              <p>
                It buckets serves by their <strong>close time</strong>, not when the table
                was seated — so a long lunch shows under when it paid. See{' '}
                <Link to="/admin/guide#metric-peak-hours">Peak hours</Link>.
              </p>
            </Collapsible>
            <Collapsible title="I deleted an expense — why didn’t the owner-cash movement go?">
              <p>
                It does now. Deleting the expense reverses its owner-cash movement
                automatically; the “Cash with owners” list and balances refresh with it.
              </p>
            </Collapsible>
            <Collapsible title="Can’t take a cash payment?">
              <p>Open a shift first — cash is blocked until the drawer is open.</p>
            </Collapsible>
          </>
        ),
      },
    ],
  },
];

/** Flat anchor → topic-id index for resolving deep links (/admin/guide#anchor). */
export const ANCHOR_TO_TOPIC: Record<string, string> = Object.fromEntries(
  GUIDE_TOPICS.flatMap((t) => t.sections.map((s) => [s.id, t.id])),
);
