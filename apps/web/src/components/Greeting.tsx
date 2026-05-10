/* Greeting
 *
 * Time-aware welcome strip on the dashboard. Displays:
 *   • a soft ambient label ("good morning" / "good afternoon" / "good evening")
 *   • the cafe name (display name from branding when set)
 *   • a configurable tagline (Settings → Personality)
 *   • an animated steaming cup with the tenant's accent emoji
 *
 * Time bands are computed in the user's local timezone — the dashboard
 * fetches its data in tenant TZ but the greeting itself is a UI flavor
 * and reading wall-clock locally is fine.
 */

import { SteamingCup } from './SteamingCup';

type Props = {
  cafeName: string;
  firstName?: string;
  tagline?: string;
  emoji?: string;
};

function band(): { label: string; defaultEmoji: string } {
  const h = new Date().getHours();
  if (h < 5) return { label: 'still up', defaultEmoji: '🌙' };
  if (h < 12) return { label: 'good morning', defaultEmoji: '☕' };
  if (h < 17) return { label: 'good afternoon', defaultEmoji: '🥐' };
  if (h < 21) return { label: 'good evening', defaultEmoji: '🍷' };
  return { label: 'good night', defaultEmoji: '🌙' };
}

export function Greeting({ cafeName, firstName, tagline, emoji }: Props) {
  const b = band();
  const accent = emoji ?? b.defaultEmoji;
  return (
    <div className="greet-card">
      <div className="greet-art" aria-hidden="true">
        <SteamingCup size={56} hero emoji={accent} />
      </div>
      <div className="greet-body">
        <span className="greet-eyebrow">{b.label}{firstName ? `, ${firstName.toLowerCase()}` : ''}.</span>
        <span className="greet-name">{cafeName}</span>
        {tagline && <span className="greet-tag">{tagline}</span>}
      </div>
    </div>
  );
}
