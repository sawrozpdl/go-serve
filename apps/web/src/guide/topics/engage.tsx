import { Gamepad2 } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const engage: GuideTopic = {
  id: 'engage',
  title: 'QR rewards',
  icon: Gamepad2,
  group: 'Grow',
  blurb: 'Guests scan, play a quick game, and win something they use now.',
  feature: 'qr_rewards',
  perm: 'engage:read',
  sections: [
    {
      id: 'engage-what',
      heading: 'How it works',
      keywords: ['engage', 'qr rewards', 'game', 'campaign', 'guest', 'play', 'win', 'loyalty', 'retention'],
      body: (
        <>
          <p>
            One QR for the whole café. A guest scans it, plays a short game on their own
            phone, and wins a reward the cashier applies to their bill. It gives people
            something to do while they wait, and gives you a reason for them to come back.
          </p>
          <p>
            Four tabs: <strong>Campaign</strong> (the game and the rules),{' '}
            <strong>Rewards</strong> (what can be won), <strong>Results</strong> (whether
            it’s working) and <strong>Contacts</strong> (guests who chose to leave details).
          </p>
          <TryIt to="/admin/engage/campaign">Open Engage</TryIt>
        </>
      ),
    },
    {
      id: 'engage-setup',
      heading: 'Setting up a campaign',
      keywords: ['game', 'tea runner', 'memory match', 'stack', 'schedule', 'days', 'accessibility'],
      body: (
        <>
          <p>Pick one of three games:</p>
          <ul>
            <li><strong>Tea Runner</strong> — tap to keep the cup flying through the gaps. The most game-like, and the one that needs quick reflexes.</li>
            <li><strong>Memory Match</strong> — find the pairs before the timer runs out. No reflexes needed, and it works with a keyboard or a screen reader. Pick this if you want everyone to be able to join in.</li>
            <li><strong>Stack</strong> — tap to drop each block and keep the tower wide. One tap, but still timed.</li>
          </ul>
          <p>
            The game changes how it <em>feels</em>, not what it costs you — your reward
            tiers control that. You can also limit the campaign to particular days, and set
            an end date or leave it running until you pause it.
          </p>
          <p>
            There’s an option to let guests claim without playing, which quietly gives your
            lowest reward. Worth switching on if you’d rather nobody was excluded by
            reflexes, eyesight or an old phone.
          </p>
        </>
      ),
    },
    {
      id: 'engage-rewards',
      heading: 'The reward ladder and your budget',
      keywords: ['reward', 'tier', 'ladder', 'score', 'percent off', 'free item', 'consolation', 'budget', 'cap'],
      body: (
        <>
          <p>
            Rewards are a ladder: each tier has a score to reach and a prize — a percentage
            off, a fixed amount off, a free item, or nothing at all as a consolation. A
            guest wins the highest tier their score reaches.
          </p>
          <p>
            Set <strong>budget caps</strong> — how many rewards a day, and how much they can
            be worth. They’re checked <em>before</em> a guest plays, never after: once the
            day’s budget is gone the page opens in practice mode, so nobody wins something
            you then have to refuse.
          </p>
          <Collapsible title="Start smaller than feels generous">
            <p>
              The page shows a worst case — what it costs if every guest clears your top
              tier. Read that number before going live. A ladder that looks modest per guest
              is a real weekly cost at fifty scans a day, and it is much easier to raise a
              reward later than to take one away.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'engage-redeeming',
      heading: 'Redeeming at the till',
      keywords: ['redeem', 'code', 'expire', 'five minutes', 'grace', 'cashier', 'apply'],
      body: (
        <>
          <p>
            The guest shows a short code. Enter it while settling and it applies as a
            discount on that bill.
          </p>
          <p>
            A won reward is deliberately short-lived — a few minutes by default. That’s what
            makes it a reason to order now rather than a coupon to save, and it’s why a
            shared link is worth nothing to someone who isn’t in the café. There’s a{' '}
            <strong>counter grace</strong> setting for exactly the obvious problem: a guest
            shouldn’t lose their prize because your queue was long.
          </p>
          <p>
            The QR itself never changes and never expires. Every scan starts a fresh game.
          </p>
        </>
      ),
    },
    {
      id: 'engage-results',
      heading: 'Results and contacts',
      keywords: ['results', 'analytics', 'scanned', 'redeemed', 'conversion', 'contacts', 'consent', 'phone', 'email'],
      body: (
        <>
          <p>
            <strong>Results</strong> shows scans, games played, rewards won and — the number
            that actually matters — how many were redeemed. A campaign with plenty of plays
            and few redemptions isn’t reaching the till.
          </p>
          <p>
            If nobody has scanned at all, the usual reason is the least interesting one: the
            table tents never got printed.
          </p>
          <p>
            <strong>Contacts</strong> holds details from guests who chose to share them
            after winning. It’s optional and consented — most won’t, and the reward works
            either way. Treat that list accordingly: people gave you a phone number for a
            free coffee, not for a mailing list.
          </p>
        </>
      ),
    },
  ],
};
