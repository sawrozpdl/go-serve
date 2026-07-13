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
            On the tab, add menu items and press <strong>Send</strong>. Sent items print
            a kitchen docket and appear on the Kitchen display. Items marked “auto-ready”
            skip the kitchen.
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
];

export const tourById: Record<string, Tour> = Object.fromEntries(TOURS.map((t) => [t.id, t]));
