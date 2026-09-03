/* The written guide, assembled.
 *
 * One topic per file under ./topics — the prose outgrew a single module, and a
 * change to the Engage copy should not produce a diff that also touches the
 * shift reconciliation copy. This file's only job is the order things appear in
 * and the flat anchor index that resolves deep links.
 */
import { GUIDE_GROUPS, type GuideGroup, type GuideTopic } from './types';

import { welcome } from './topics/welcome';
import { gettingStarted } from './topics/gettingStarted';
import { mobile } from './topics/mobile';
import { floor } from './topics/floor';
import { kitchen } from './topics/kitchen';
import { settle } from './topics/settle';
import { credit } from './topics/credit';
import { shifts } from './topics/shifts';
import { offline } from './topics/offline';
import { menu } from './topics/menu';
import { tables } from './topics/tables';
import { stations } from './topics/stations';
import { printing } from './topics/printing';
import { people } from './topics/people';
import { settings } from './topics/settings';
import { plan } from './topics/plan';
import { expenses } from './topics/expenses';
import { inventory } from './topics/inventory';
import { accounts } from './topics/accounts';
import { owners } from './topics/owners';
import { numbers } from './topics/numbers';
import { reports } from './topics/reports';
import { findings } from './topics/findings';
import { qrMenu } from './topics/qrMenu';
import { engage } from './topics/engage';
import { activity } from './topics/activity';
import { glossary } from './topics/glossary';
import { faq } from './topics/faq';

export { GUIDE_GROUPS } from './types';
export type { GuideGroup, GuideSection, GuideTopic } from './types';

/* Reading order. Within a group this is the order the rail renders, so it runs
 * roughly "what you do first" → "what you set up once" → "what you look at
 * later" rather than alphabetically. */
export const GUIDE_TOPICS: GuideTopic[] = [
  // Start here
  welcome,
  gettingStarted,
  mobile,

  // Daily service
  floor,
  kitchen,
  settle,
  credit,
  shifts,
  offline,

  // Your café setup
  menu,
  tables,
  stations,
  printing,
  people,
  settings,
  plan,

  // Money & stock
  numbers,
  expenses,
  inventory,
  accounts,
  owners,
  reports,
  findings,

  // Grow
  qrMenu,
  engage,

  // Reference
  activity,
  glossary,
  faq,
];

/** Topics bucketed for the rail, in `GUIDE_GROUPS` order. Empty groups are
 *  dropped so adding a group name costs nothing until a topic uses it. */
export const GUIDE_TOPICS_BY_GROUP: { group: GuideGroup; topics: GuideTopic[] }[] = GUIDE_GROUPS
  .map((group) => ({ group, topics: GUIDE_TOPICS.filter((t) => t.group === group) }))
  .filter((g) => g.topics.length > 0);

/** Flat anchor → topic-id index for resolving deep links
 *  (/admin/learn/guide#anchor). */
export const ANCHOR_TO_TOPIC: Record<string, string> = Object.fromEntries(
  GUIDE_TOPICS.flatMap((t) => t.sections.map((s) => [s.id, t.id])),
);
