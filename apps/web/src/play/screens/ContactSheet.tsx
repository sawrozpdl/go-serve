import { useState } from 'react';

import { PlayApiError, submitPlayContact } from '../lib/playApi';

// =========================================================================
// Optional contact capture, shown after the reveal.
//
// The consent rules, which are the point of this component:
//
//   * the box starts UNCHECKED and Save stays disabled until it is ticked;
//   * Skip has the same visual weight as Save;
//   * the reward code is already on screen and already copyable — nothing here
//     gates it. Consent is never the price of the prize.
//
// The exact wording agreed to is versioned and sent with the submission, so a
// café can later answer "what did this person actually agree to?" with the text
// rather than a guess.
// =========================================================================

/** Bump this whenever CONSENT_TEXT changes, so old consents stay attributable
 *  to the wording they were given. */
export const CONSENT_VERSION = 'v1';

const CONSENT_TEXT =
  'Yes, the café can contact me about offers. I can ask them to delete my details at any time.';

export function ContactSheet({
  slug,
  sessionToken,
  onDone,
}: {
  slug: string;
  sessionToken: string;
  onDone: () => void;
}) {
  const [channel, setChannel] = useState<'phone' | 'email'>('phone');
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consent || !value.trim()) return;
    setBusy(true);
    setError('');
    try {
      await submitPlayContact(slug, sessionToken, {
        name: name.trim(),
        email: channel === 'email' ? value.trim() : '',
        phone: channel === 'phone' ? value.trim() : '',
        consentTextVersion: CONSENT_VERSION,
      });
      setSaved(true);
      window.setTimeout(onDone, 1400);
    } catch (err) {
      setError(err instanceof PlayApiError ? err.message : 'Could not save that.');
      setBusy(false);
    }
  };

  if (saved) {
    return (
      <div className="pl-contact pl-contact--done" role="status">
        Thanks — see you soon.
      </div>
    );
  }

  return (
    <form className="pl-contact" onSubmit={submit}>
      <p className="pl-contact__lead">Want the café to let you know about the next one?</p>

      <div className="pl-contact__channel" role="group" aria-label="Contact by">
        <button
          type="button"
          className={`pl-chip${channel === 'phone' ? ' is-on' : ''}`}
          onClick={() => setChannel('phone')}
          aria-pressed={channel === 'phone'}
        >
          Phone
        </button>
        <button
          type="button"
          className={`pl-chip${channel === 'email' ? ' is-on' : ''}`}
          onClick={() => setChannel('email')}
          aria-pressed={channel === 'email'}
        >
          Email
        </button>
      </div>

      <label className="pl-contact__field">
        <span className="pl-visually-hidden">Your name (optional)</span>
        <input
          type="text"
          placeholder="Your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          maxLength={120}
        />
      </label>

      <label className="pl-contact__field">
        <span className="pl-visually-hidden">{channel === 'phone' ? 'Phone number' : 'Email address'}</span>
        <input
          type={channel === 'phone' ? 'tel' : 'email'}
          inputMode={channel === 'phone' ? 'tel' : 'email'}
          placeholder={channel === 'phone' ? 'Phone number' : 'Email address'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete={channel === 'phone' ? 'tel' : 'email'}
          maxLength={channel === 'phone' ? 40 : 200}
          required
        />
      </label>

      <label className="pl-contact__consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{CONSENT_TEXT}</span>
      </label>

      {error && <p className="pl-contact__error">{error}</p>}

      <div className="pl-contact__actions">
        {/* Equal weight, deliberately. */}
        <button type="button" className="pl-btn pl-btn--ghost" onClick={onDone}>
          Skip
        </button>
        <button type="submit" className="pl-btn pl-btn--primary" disabled={!consent || !value.trim() || busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
