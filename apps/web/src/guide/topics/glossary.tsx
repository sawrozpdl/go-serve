import { BookOpen } from 'lucide-react';

import type { GuideTopic } from '../types';

export const glossary: GuideTopic = {
  id: 'glossary',
  title: 'Glossary',
  icon: BookOpen,
  group: 'Reference',
  blurb: 'Plain-English definitions of every GoServe term.',
  sections: [
    {
      id: 'glossary-service',
      heading: 'Service',
      keywords: ['serve', 'tab', 'walk-in', 'send', 'docket', 'kot', 'station', 'add-on', 'half plate', 'void'],
      body: (
        <dl className="guide-glossary">
          <dt>Serve</dt>
          <dd>One order — a table’s bill, or a walk-in. The unit sales are counted in.</dd>
          <dt>Tab</dt>
          <dd>A serve while it’s still open. Items go on the tab; the tab becomes a bill.</dd>
          <dt>Serve type</dt>
          <dd>
            Dine-in, takeaway or delivery. Independent of whether the serve holds a
            table, so a seated tab can be switched to takeaway without giving up its
            table. Anything but dine-in prints in bold on the kitchen docket.
          </dd>
          <dt>Walk-in</dt>
          <dd>A serve with no table — someone at the counter. Can be given a name after it’s opened.</dd>
          <dt>Send</dt>
          <dd>Push what’s on the tab to the kitchen. Adding an item is not sending it.</dd>
          <dt>Docket / KOT</dt>
          <dd>The kitchen slip printed when a tab is sent. Lists only what needs making.</dd>
          <dt>Station</dt>
          <dd>A place where food or drink is prepared — Kitchen, Bar. Decides which board and printer a ticket goes to.</dd>
          <dt>Kitchen behaviour</dt>
          <dd>Whether an item is cooked, marked ready on send, or served immediately without touching the kitchen board.</dd>
          <dt>Add-on</dt>
          <dd>A reusable extra (extra shot, extra cheese). Its price is folded into the line rather than charged separately.</dd>
          <dt>Half plate</dt>
          <dd>An item that can be ordered in ½ steps, with the price scaling to match.</dd>
          <dt>Void</dt>
          <dd>Taking a sent item off a serve, with a reason. Recorded, because food may already have been made.</dd>
        </dl>
      ),
    },
    {
      id: 'glossary-money-in',
      heading: 'Money coming in',
      keywords: ['settle', 'close', 'billed sales', 'net revenue', 'credit', 'collected', 'discount', 'vat', 'service charge', 'reward code'],
      body: (
        <dl className="guide-glossary">
          <dt>Close / settle</dt>
          <dd>Taking payment and finishing a serve. This is when it becomes Sales and appears in History.</dd>
          <dt>Billed sales</dt>
          <dd>The grand total of every serve closed in the period — discounts already off, tax and service already in, exactly as on the receipt.</dd>
          <dt>Net revenue</dt>
          <dd>What the café actually earned, with tax and service charge stripped out. The right basis for margin.</dd>
          <dt>Credit</dt>
          <dd>A regular’s running account — a khata. A sale recorded now, cash collected later.</dd>
          <dt>On credit (not in hand)</dt>
          <dd>The portion of sales billed to credit accounts and not yet collected.</dd>
          <dt>Credit collected</dt>
          <dd>Money received against an old credit balance. It moves cash between buckets; it is never new revenue.</dd>
          <dt>Discount</dt>
          <dd>An amount or percentage off a bill, with a reason. Always requires an explicit Apply.</dd>
          <dt>Reward code</dt>
          <dd>A short-lived code won on the QR game, entered at settle. Behaves as a discount.</dd>
          <dt>VAT mode</dt>
          <dd>Whether prices include VAT, VAT is added on top, or no VAT is charged at all.</dd>
          <dt>Service charge</dt>
          <dd>An optional percentage added to every bill, shown separately from VAT.</dd>
        </dl>
      ),
    },
    {
      id: 'glossary-money-held',
      heading: 'Money you hold',
      keywords: ['drawer', 'float', 'cash drop', 'variance', 'expected cash', 'transfer', 'fee', 'café balance', 'owner cash', 'opening balance'],
      body: (
        <dl className="guide-glossary">
          <dt>Café balance</dt>
          <dd>The money you hold right now, across the drawer, the bank, online, and cash with owners.</dd>
          <dt>Shift</dt>
          <dd>One session of the physical cash drawer, opened with a float and closed with a count.</dd>
          <dt>Float</dt>
          <dd>The cash in the till when a shift opens.</dd>
          <dt>Cash drop</dt>
          <dd>Cash moved in or out of the drawer mid-shift — to the bank, or change brought in.</dd>
          <dt>Expected cash</dt>
          <dd>What the drawer should hold at close: float + cash in − cash out.</dd>
          <dt>Variance</dt>
          <dd>The difference between the counted drawer and what was expected. Recorded, not corrected away.</dd>
          <dt>Transfer</dt>
          <dd>Money moved between your own accounts. Never changes the balance — except for its fee, which does.</dd>
          <dt>Cash with owners</dt>
          <dd>Café cash an owner has taken but not yet reconciled. Still café money, just in a pocket.</dd>
          <dt>Opening balance</dt>
          <dd>What was already true before you started using the software — cash in the till, or a customer’s existing debt.</dd>
        </dl>
      ),
    },
    {
      id: 'glossary-money-out',
      heading: 'Costs and profit',
      keywords: ['cogs', 'direct cost', 'allocated', 'overhead', 'gross margin', 'net profit', 'investment', 'loan', 'payout', 'equity'],
      body: (
        <dl className="guide-glossary">
          <dt>Direct cost (COGS)</dt>
          <dd>The per-unit cost set on a menu item, captured at the time of sale.</dd>
          <dt>Allocated cost</dt>
          <dd>The slice of an expense you’ve tagged to a menu category.</dd>
          <dt>Overhead</dt>
          <dd>An expense not attached to any category — rent, wages, wifi. Still counts fully toward net profit.</dd>
          <dt>Gross margin</dt>
          <dd>Revenue − (direct + allocated cost), per category. A pricing lens, not a bottom line.</dd>
          <dt>Net profit</dt>
          <dd>Sales − all expenses for the period. The cash bottom line.</dd>
          <dt>Investment</dt>
          <dd>Capital an owner puts in permanently. Buys equity; not expected back.</dd>
          <dt>Loan</dt>
          <dd>Money an owner lends the café. A debt the café owes, sitting outside the balance.</dd>
          <dt>Payout</dt>
          <dd>Profit taken out by an owner. Reduces the café’s money, but is not an expense of trading.</dd>
          <dt>Equity</dt>
          <dd>An owner’s share of the café, from their shares and what they’ve put in.</dd>
        </dl>
      ),
    },
    {
      id: 'glossary-system',
      heading: 'The system itself',
      keywords: ['member', 'staff', 'role', 'permission', 'seat', 'plan feature', 'finding', 'brief', 'sync tray', 'workspace'],
      body: (
        <dl className="guide-glossary">
          <dt>Member</dt>
          <dd>An account that can log in to this café.</dd>
          <dt>Staff</dt>
          <dd>A record of someone who works here. Separate from a member — many staff never log in.</dd>
          <dt>Role</dt>
          <dd>A named bundle of permissions. The only thing deciding what a person can see or do.</dd>
          <dt>Permission</dt>
          <dd>One specific ability, like “settle an order” or “see reports”.</dd>
          <dt>Seat</dt>
          <dd>One member who can log in. Pending invites use a seat too.</dd>
          <dt>Plan feature</dt>
          <dd>A part of the app switched on for your café by its plan — inventory, profitability, audit logs and so on.</dd>
          <dt>Finding</dt>
          <dd>Something the nightly check noticed in your books that needs a decision.</dd>
          <dt>Morning brief</dt>
          <dd>The email of those findings, sent before opening, and only when there is something to say.</dd>
          <dt>Sync review</dt>
          <dd>Offline changes the server refused on reconnect, held for a person to decide about rather than dropped.</dd>
          <dt>Workspace</dt>
          <dd>One café. If you run more than one, you pick which after signing in.</dd>
        </dl>
      ),
    },
  ],
};
