import type { ReactNode } from 'react';
import { ArrowRight, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';

import { usePermissions } from '@/lib/permissions';
import { hasFeature } from '@/lib/api';
import { featureLabel, CONTACT_EMAIL } from '@/lib/features';
import type { GuideTopic } from './types';

/** Inline "jump into the real screen" button. */
export function TryIt({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="guide-tryit" to={to}>
      {children} <ArrowRight size={13} strokeWidth={1.8} aria-hidden />
    </Link>
  );
}

/**
 * Says up front when a topic describes something this café cannot currently
 * reach — either the plan does not include it, or this member's role does not.
 *
 * The alternative was to hide such topics from the rail. That reads as tidier
 * and is worse: an owner who never sees "Stations" cannot discover that
 * stations exist, and a "Learn more →" link into a hidden topic would land on
 * nothing. Naming the reason costs one line and answers the question the reader
 * would otherwise ask support.
 */
export function TopicAvailability({ topic }: { topic: GuideTopic }) {
  const { me, isLoading, can } = usePermissions();

  // Say nothing until we know. `hasFeature(undefined, …)` is false, so rendering
  // during the /me fetch would tell every reader their plan lacks the feature —
  // and then quietly retract it a moment later.
  if (isLoading || !me) return null;

  const planMissing = topic.feature ? !hasFeature(me, topic.feature) : false;
  const permMissing = topic.perm ? !can(topic.perm) : false;
  if (!planMissing && !permMissing) return null;

  return (
    <p className="guide-availability">
      <Lock size={13} strokeWidth={1.8} aria-hidden />
      <span>
        {planMissing && (
          <>
            <strong>{featureLabel(topic.feature!)}</strong> isn’t part of your café’s plan
            yet, so you won’t find it in the sidebar. Everything below still describes how
            it works — <a href={`mailto:${CONTACT_EMAIL}`}>ask us</a> to turn it on.
          </>
        )}
        {planMissing && permMissing && ' '}
        {permMissing && (
          <>
            Your role doesn’t include the permission these screens need, so they’re hidden
            from your sidebar. Whoever owns the café can grant it under{' '}
            <Link to="/admin/people/roles">People → Roles</Link>.
          </>
        )}
      </span>
    </p>
  );
}
