import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Permission } from '@cafe-mgmt/rbac';

/* Types for the written guide.
 *
 * They live in their own module, not in content.tsx, because content.tsx now
 * imports every topic file and every topic file needs these types — putting
 * them together would make the module graph a cycle.
 */

export type GuideSection = {
  /** Unique anchor across the whole guide (used for deep links). */
  id: string;
  heading: string;
  body: ReactNode;
  /** If set, the section offers a "Start walkthrough" button for this tour id. */
  tour?: string;
  /**
   * Extra search terms for this section.
   *
   * Search matches titles and headings only — a ReactNode body cannot be
   * searched without rendering it. With two dozen topics that gap is the
   * difference between finding "add-on" and concluding the app has no add-ons,
   * so anything a reader would plausibly type goes here.
   */
  keywords?: string[];
};

/** Rail grouping. Order here is the order the rail renders. */
export const GUIDE_GROUPS = [
  'Start here',
  'Daily service',
  'Your café setup',
  'Money & stock',
  'Grow',
  'Reference',
] as const;

export type GuideGroup = (typeof GUIDE_GROUPS)[number];

export type GuideTopic = {
  id: string;
  title: string;
  icon: LucideIcon;
  group: GuideGroup;
  /** One-liner for the rail and search. */
  blurb: string;
  /**
   * Plan feature this topic describes, if any. The topic is still shown to
   * everyone — hiding it would leave the reader unable to find out the feature
   * exists, and would dead-end any deep link into it — but a café whose plan
   * does not include it gets told so at the top, rather than hunting for a
   * screen that is not in their sidebar.
   */
  feature?: string;
  /** Permission the topic's screens need. Same reasoning as `feature`. */
  perm?: Permission;
  sections: GuideSection[];
};
