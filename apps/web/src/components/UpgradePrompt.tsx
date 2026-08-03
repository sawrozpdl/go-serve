import { Lock, Mail, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import { KNOWN_FEATURES, CONTACT_EMAIL, CONTACT_PHONE } from '@/lib/features';
import { Can } from '@/lib/permissions';

// Shown in place of a premium feature the tenant's plan doesn't include. No
// checkout — upgrades are handled by reaching out to us (manual billing).
// "View plan" is gated on the Settings page's own permission: without it the
// link just bounced the member back to /admin.
export function UpgradePrompt({ feature, compact }: { feature: string; compact?: boolean }) {
  const meta = KNOWN_FEATURES[feature];
  const subject = encodeURIComponent(`Upgrade request — ${meta?.label ?? feature}`);
  return (
    <div className="banner-info upgrade-prompt" style={compact ? { padding: 'var(--space-3)' } : undefined}>
      <div className="upgrade-prompt-head">
        <Lock size={16} strokeWidth={1.8} />
        <strong>{meta?.label ?? feature} is a premium feature</strong>
      </div>
      {!compact && meta?.desc && <p className="upgrade-prompt-desc">{meta.desc}</p>}
      <div className="upgrade-prompt-actions">
        <a className="btn primary" href={`mailto:${CONTACT_EMAIL}?subject=${subject}`}>
          <Mail size={14} strokeWidth={1.8} style={{ marginRight: 6 }} />
          Contact us to upgrade
        </a>
        <Can perm="tenant:update">
          <Link className="btn" to="/admin/settings" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            View plan <ArrowRight size={14} strokeWidth={1.6} />
          </Link>
        </Can>
      </div>
      {CONTACT_PHONE && <p className="upgrade-prompt-phone">or call {CONTACT_PHONE}</p>}
    </div>
  );
}
