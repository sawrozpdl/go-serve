import { Coffee } from 'lucide-react';

import { Collapsible } from '@/components/Collapsible';
import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const menu: GuideTopic = {
  id: 'menu',
  title: 'Your menu',
  icon: Coffee,
  group: 'Your café setup',
  blurb: 'Categories, items, cost, add-ons and bulk import.',
  sections: [
    {
      id: 'menu-structure',
      heading: 'Categories and items',
      tour: 'build-menu',
      keywords: ['menu', 'category', 'item', 'price', 'photo', 'icon', 'sku', 'featured', 'pin', 'sort'],
      body: (
        <>
          <p>
            Categories come first — Hot Coffee, Momo, Cigarettes — and items live inside
            them. A category isn’t only a heading: it’s the bucket revenue and cost roll up
            into on the Profitability report, so group things the way you’d want to read
            them later, not the way they sit on the printed card.
          </p>
          <p>
            Each item carries a name, a category, a price, and optionally a photo, an icon,
            a short <strong>SKU</strong> for receipts, and a description. Pin your busiest
            items as <strong>featured</strong> and they surface first when a waiter is
            adding to a tab — on a phone, in a rush, that’s the difference between two taps
            and a search.
          </p>
          <TryIt to="/admin/menu">Open the Menu</TryIt>
        </>
      ),
    },
    {
      id: 'menu-cost',
      heading: 'Cost per unit — the field that pays for itself',
      keywords: ['cost', 'cogs', 'margin', 'profit', 'direct cost', 'profitability'],
      body: (
        <>
          <p>
            <strong>Cost per unit</strong> is what it costs you to make or buy one. It’s
            optional, and it is the single most valuable field on this page. Fill it in and
            the editor shows you the margin as you type; leave it blank and the
            Profitability report can only guess at that item.
          </p>
          <p>
            The cost is captured <em>at the time of sale</em>, so raising a price or a
            supplier cost tomorrow doesn’t rewrite what last month earned.
          </p>
          <p>
            If you’d rather track cost through purchases instead, leave it blank and use
            Inventory plus Expenses — but do one or the other. An item with no cost
            anywhere reports as pure profit, which is the most flattering and least true
            number in the app. The nightly check tells you what proportion of your sales is
            covered by real costs, under <strong>Findings</strong>.
          </p>
        </>
      ),
    },
    {
      id: 'menu-addons',
      heading: 'Add-ons',
      keywords: ['add-on', 'addon', 'modifier', 'extra', 'options', 'extra shot', 'extra cheese', 'group'],
      body: (
        <>
          <p>
            Add-ons are reusable groups of extras. Make a group once — “Sandwich extras”
            with extra cheese, extra egg — and attach it to the items that offer it, or to a
            whole category so every drink in it can take an extra shot.
          </p>
          <p>
            Each group can require a minimum and cap a maximum number of choices, so “pick
            exactly one size” and “add as many toppings as you like” are both expressible.
          </p>
          <Collapsible title="How an add-on price shows up on the bill">
            <p>
              The add-on’s price is folded into the line’s price rather than listed as a
              separate charge. A coffee at 120 with a 30 shot is one line at 150, with the
              add-on named underneath. The kitchen docket shows the extras indented under
              the item so the cook reads it as one instruction, and the guest sees one
              number instead of arithmetic.
            </p>
          </Collapsible>
        </>
      ),
    },
    {
      id: 'menu-import',
      heading: 'Importing a printed menu',
      keywords: ['import', 'bulk', 'ai', 'chatgpt', 'json', 'photo', 'pdf', 'migrate menu'],
      body: (
        <>
          <p>
            Typing in two hundred items is nobody’s idea of a good evening.{' '}
            <strong>Import menu</strong> gives you a prompt to copy, which you paste into
            ChatGPT (or any assistant) along with a photo or PDF of your menu. Paste the
            JSON it hands back and you get a preview of every category and item, each
            marked <em>new</em>, <em>update</em> or <em>skip</em>, before anything is saved.
          </p>
          <p>
            Nothing about your café is sent to the AI — the prompt is ours, the model is
            yours, and only the result comes back here. Review the preview properly: prices
            read off a photo are usually right and occasionally confidently wrong.
          </p>
        </>
      ),
    },
    {
      id: 'menu-routing',
      heading: 'Where an item goes when it’s sent',
      keywords: ['kitchen behaviour', 'station', 'outlet', 'routing', 'half plate', 'inventory link', 'quick notes'],
      body: (
        <>
          <p>Three settings on an item decide what happens after a waiter sends it:</p>
          <ul>
            <li>
              <strong>Kitchen behaviour</strong> — cook it, mark it ready on send, or serve
              it immediately. Explained under <strong>The Kitchen display</strong>.
            </li>
            <li>
              <strong>Station</strong> — which prep point it prints and displays at, if you
              run more than one. See <strong>Stations</strong>.
            </li>
            <li>
              <strong>Inventory links</strong> — when the serve closes, deduct stock. One
              cigarette sold, one stick off the shelf. Add several for a combo.
            </li>
          </ul>
          <p>
            Also worth setting: <strong>half plates</strong> for shareable dishes, and{' '}
            <strong>quick notes</strong> — one-tap chips like “low sugar” or “no ice” that
            save a waiter typing the same thing forty times a week.
          </p>
        </>
      ),
    },
  ],
};
