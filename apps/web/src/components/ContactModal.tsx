import { Mail, Phone } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { SUPPORT_CONTACTS } from '@/lib/features';

/**
 * "Contact us" — a small modal listing the support team, each with quick
 * Email / Call actions (mailto: / tel: anchors). Reused from the account menu.
 */
export function ContactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Contact us" subtitle="We're happy to help">
      <div className="contact-list">
        {SUPPORT_CONTACTS.map((c) => (
          <div key={c.name} className="contact-card">
            <div className="contact-card__info">
              <div className="contact-card__name">{c.name}</div>
              <div className="contact-card__meta">
                {c.email}
                {c.phone ? ` · ${c.phone}` : ''}
              </div>
            </div>
            <div className="contact-card__actions">
              <a
                className="btn"
                href={`mailto:${c.email}?subject=${encodeURIComponent('GoServe — support')}`}
              >
                <Mail size={14} strokeWidth={1.6} /> Email
              </a>
              {c.phone && (
                <a className="btn" href={`tel:${c.phone.replace(/\s+/g, '')}`}>
                  <Phone size={14} strokeWidth={1.6} /> Call
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
