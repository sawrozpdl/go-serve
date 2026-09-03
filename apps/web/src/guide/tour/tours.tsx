import type { Tour } from './types';

// Guided walkthroughs. Steps with a `target` spotlight a real element (tagged
// with data-tour="..."); steps with only a `route` + prose show a centered
// card. Tours can walk across pages via `route`.

export const TOURS: Tour[] = [
  {
    id: 'first-serve',
    name: 'Your first serve',
    blurb: 'From an empty table to a settled bill, step by step.',
    steps: [
      {
        route: '/admin/floor',
        title: 'Welcome to the Floor',
        body: (
          <>
            This is your floor — every table at a glance. Green-ish tiles are running
            serves; quiet tiles are free. Let’s walk a serve from start to finish.
          </>
        ),
      },
      {
        route: '/admin/floor',
        target: '[data-tour="floor-tables"]',
        title: 'Open a serve',
        body: (
          <>
            Tap a free table to start a serve (or use a Walk-in tile for takeaway). That
            opens the table’s tab where you add items.
          </>
        ),
      },
      {
        route: '/admin/floor',
        title: 'Add items & send to the kitchen',
        body: (
          <>
            On the tab, add menu items and press <strong>Send</strong>. Adding is not
            sending — nothing is cooked until you send. Sent items print a kitchen docket
            and appear on the Kitchen display, unless their <strong>kitchen behaviour</strong>{' '}
            says to skip it (packaged drinks, cigarettes).
          </>
        ),
      },
      {
        route: '/admin/floor',
        title: 'Settle the bill',
        body: (
          <>
            When the guest pays, open the tab and <strong>Settle</strong>: choose cash,
            online, or put it on credit. Settling <em>closes the serve</em> — that’s
            when it counts toward Sales and the day’s history.
          </>
        ),
      },
    ],
  },
  {
    id: 'dashboard',
    name: 'Reading your dashboard',
    blurb: 'What each number means and how the period control works.',
    steps: [
      {
        route: '/admin',
        target: '[data-tour="dash-period"]',
        title: 'Pick your period',
        body: (
          <>
            Everything below reacts to this control. Use the quick presets, or the month
            jumper to view any past month or a custom range. “Cafe balance” is the one
            exception — it’s always live.
          </>
        ),
      },
      {
        route: '/admin',
        target: '[data-tour="dash-kpis"]',
        title: 'Your headline numbers',
        body: (
          <>
            Sales, orders and the net bottom line for the period. Hover any{' '}
            <strong>ⓘ</strong> to see exactly how it’s calculated, with a link into this
            guide.
          </>
        ),
      },
      {
        route: '/admin',
        target: '[data-tour="dash-daily"]',
        title: 'Daily sales & average',
        body: (
          <>
            Each bar is a day’s takings; the dashed line is the average. Switch to the list
            for exact numbers, or click a day to open its full history.
          </>
        ),
      },
    ],
  },
  {
    id: 'close-shift',
    name: 'Opening & closing a shift',
    blurb: 'Run the cash drawer cleanly so variance stays honest.',
    steps: [
      {
        route: '/admin/shift',
        target: '[data-tour="shift-form"]',
        title: 'The drawer shift',
        body: (
          <>
            A shift tracks the cash drawer. <strong>Open</strong> one with your starting
            float before taking cash payments — cash is blocked until a shift is open.
          </>
        ),
      },
      {
        route: '/admin/shift',
        target: '[data-tour="shift-form"]',
        title: 'Close & count',
        body: (
          <>
            At the end, <strong>close</strong> the shift and count the drawer. GoServe
            compares your count to what it expected (float + cash sales − drops) and stamps
            the <strong>variance</strong>. That’s why deleting old cash entries is blocked
            once a shift is closed.
          </>
        ),
      },
    ],
  },
  {
    id: 'build-menu',
    name: 'Building your menu',
    blurb: 'Category, item, cost, add-ons — the order that avoids rework.',
    steps: [
      {
        route: '/admin/menu',
        target: '[data-tour="menu-categories"]',
        title: 'Categories come first',
        body: (
          <>
            An item has to live in a category, so start here. A category isn’t just a
            heading — it’s the bucket revenue and cost roll up into on the Profitability
            report, so group things the way you’d want to read them later.
          </>
        ),
      },
      {
        route: '/admin/menu',
        target: '[data-tour="menu-new-item"]',
        title: 'Add an item',
        body: (
          <>
            Pick a category, then <strong>New item</strong>. Name and price are the
            minimum; a photo and a short description are what make the public QR menu worth
            scanning.
          </>
        ),
      },
      {
        route: '/admin/menu',
        title: 'Fill in the cost per unit',
        body: (
          <>
            It’s optional, and it’s the most valuable field on the form. Without it, that
            item reports a 100% margin — flattering and false. The editor shows you the
            margin as you type.
          </>
        ),
      },
      {
        route: '/admin/menu',
        target: '[data-tour="menu-addons"]',
        title: 'Add-ons, once',
        body: (
          <>
            Build a group like “Sandwich extras” here, then attach it to the items — or the
            whole category — that offer it. The add-on’s price folds into the line, so the
            guest sees one honest number instead of arithmetic.
          </>
        ),
      },
    ],
  },
  {
    id: 'first-expense',
    name: 'Recording an expense',
    blurb: 'Where the money went, and which pocket it came out of.',
    steps: [
      {
        route: '/admin/expenses',
        target: '[data-tour="expense-categories"]',
        title: 'Set up categories first',
        body: (
          <>
            Expense categories are your own — supplies, rent, gas, salary. A handful of
            broad ones beats thirty precise ones nobody picks consistently.
          </>
        ),
      },
      {
        route: '/admin/expenses',
        target: '[data-tour="expense-new"]',
        title: 'Log the spend',
        body: (
          <>
            Vendor, category, amount, and the date it was actually{' '}
            <strong>paid</strong> — expenses land in a period by their paid date, not by
            when you typed them in.
          </>
        ),
      },
      {
        route: '/admin/expenses',
        title: 'Which pocket did it come from?',
        body: (
          <>
            <strong>Paid from</strong> — the drawer, the bank, or cash an owner is holding —
            is the field that keeps your café balance true. The amount alone isn’t enough:
            money left, and the app has to know from where.
          </>
        ),
      },
      {
        route: '/admin/expenses',
        title: 'Allocate it, if it belongs to a category',
        body: (
          <>
            A flour purchase can be tagged to Momos, which feeds category gross margin.
            Rent and wages belong nowhere in particular — leave those unallocated. They
            still count fully toward net profit either way.
          </>
        ),
      },
    ],
  },
  {
    id: 'credit-settle',
    name: 'Credit, end to end',
    blurb: 'Put a bill on a regular’s account, then collect it later.',
    steps: [
      {
        route: '/admin/house-tabs',
        target: '[data-tour="credit-new"]',
        title: 'Open an account',
        body: (
          <>
            One account per regular, staff member or neighbouring shop. Add their phone
            number — it’s the difference between chasing a balance and staring at a name
            you can’t place six weeks later.
          </>
        ),
      },
      {
        route: '/admin/floor',
        title: 'Settle a bill onto it',
        body: (
          <>
            On the Floor, settle the serve and choose <strong>Credit</strong>, then pick the
            account. The sale counts today at full value; the cash simply isn’t in your hand
            yet.
          </>
        ),
      },
      {
        route: '/admin/house-tabs',
        target: '[data-tour="credit-owed"]',
        title: 'Watch what you’re owed',
        body: (
          <>
            The total here is money earned but not collected. It is deliberately{' '}
            <em>not</em> part of your café balance — that’s cash you hold, and this isn’t
            cash yet.
          </>
        ),
      },
      {
        route: '/admin/house-tabs',
        title: 'Collect it',
        body: (
          <>
            Open the account and <strong>Record settlement</strong>, choosing where the money
            actually landed — drawer, online or bank. That’s reported as{' '}
            <strong>credit collected</strong>, never as a new sale: the sale was counted the
            day the food went out.
          </>
        ),
      },
    ],
  },
];

export const tourById: Record<string, Tour> = Object.fromEntries(TOURS.map((t) => [t.id, t]));
