import { History } from 'lucide-react';

import { TryIt } from '../components';
import type { GuideTopic } from '../types';

export const activity: GuideTopic = {
  id: 'activity',
  title: 'Activity log',
  icon: History,
  group: 'Reference',
  blurb: 'Who changed what, when.',
  feature: 'audit_logs',
  perm: 'audit:read',
  sections: [
    {
      id: 'activity-what',
      heading: 'What it records',
      keywords: ['audit', 'activity', 'log', 'history', 'who did', 'trail', 'oversight', 'timeline'],
      body: (
        <>
          <p>
            A timeline of changes: who voided the item, who deleted the expense, who changed
            the price, who removed a member. Each entry carries the person, the time, and
            what changed.
          </p>
          <p>
            It exists for the question that comes up after the fact — “when did this
            change?” — which is unanswerable from the current state of the data alone.
          </p>
          <TryIt to="/admin/activity">Open Activity</TryIt>
        </>
      ),
    },
    {
      id: 'activity-off',
      heading: 'It’s off unless you ask for it',
      keywords: ['off by default', 'enable', 'plan', 'missing', 'empty', 'no entries'],
      body: (
        <>
          <p>
            Audit logging is <strong>off by default</strong> and switched on per café. If
            your Activity page is empty or missing, that’s why — it isn’t broken, it simply
            wasn’t recording. Turning it on starts the record from that moment; it cannot
            reconstruct what happened before.
          </p>
          <p>
            So if you think you might want it, ask for it early. The month you wish you had
            it is always a month that’s already gone.
          </p>
        </>
      ),
    },
    {
      id: 'activity-using',
      heading: 'Using it well',
      keywords: ['investigate', 'blame', 'trust', 'roles', 'accountability'],
      body: (
        <p>
          The log is only as useful as your roles are specific. If everyone signs in as the
          owner, every entry says the owner did it and the page tells you nothing. Give
          people their own accounts and their own roles first — see{' '}
          <strong>People, roles &amp; staff</strong> — and this becomes a record worth
          having. Used as a management tool rather than a search for someone to blame, its
          real value is spotting patterns: the same correction, at the same time, every
          week.
        </p>
      ),
    },
  ],
};
