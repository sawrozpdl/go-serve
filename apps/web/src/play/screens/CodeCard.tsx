import { useEffect, useState } from 'react';

import type { PlayCode } from '../lib/playApi';

// =========================================================================
// The reward ticket.
//
// Deliberately shaped like the table tent it came from — perforated top edge,
// café mark, the reward in display type — so scanning the card and winning the
// prize are visibly the same object.
//
// The countdown is the load-bearing element, not decoration: it is what the
// guest shows the cashier, and it is why a code cannot be farmed. It counts from
// the SERVER's expiry timestamp, never a locally computed deadline, because a
// phone with a wrong clock is common and a card that looks alive when it isn't
// sends a guest to the counter to be disappointed.
// =========================================================================

function useSecondsLeft(expiresAt: string): number {
  const [left, setLeft] = useState(() => secondsUntil(expiresAt));
  useEffect(() => {
    setLeft(secondsUntil(expiresAt));
    const id = window.setInterval(() => setLeft(secondsUntil(expiresAt)), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  return left;
}

function secondsUntil(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
}

function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function CodeCard({
  code,
  cafeName,
  compact = false,
}: {
  code: PlayCode;
  cafeName: string;
  compact?: boolean;
}) {
  const left = useSecondsLeft(code.expires_at);
  const [copied, setCopied] = useState(false);
  const expired = left <= 0;
  // Under a minute the card warms up — a nudge to walk to the counter now,
  // before it becomes a disappointment.
  const urgent = !expired && left <= 60;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is blocked in plenty of mobile contexts. The code is on
      // screen in large type, which is what the cashier reads anyway.
    }
  };

  return (
    <div
      className={[
        'pl-ticket',
        compact ? 'pl-ticket--compact' : '',
        urgent ? 'is-urgent' : '',
        expired ? 'is-expired' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="pl-ticket__perf" aria-hidden="true" />
      <div className="pl-ticket__cafe">{cafeName}</div>
      <div className="pl-ticket__reward">{code.label}</div>

      <button type="button" className="pl-ticket__code num" onClick={copy} aria-label={`Reward code ${code.code}. Tap to copy.`}>
        {code.code}
      </button>
      <div className="pl-ticket__copied" aria-live="polite">
        {copied ? 'Copied' : ''}
      </div>

      {expired ? (
        // Never just vanish. The POS offers a grace override, so the honest
        // instruction is "ask anyway" rather than "too late".
        <div className="pl-ticket__expired">
          This one timed out — show it at the counter anyway, they can still honour it.
        </div>
      ) : (
        <div className="pl-ticket__timer" role="timer" aria-live="off">
          <span className="pl-ticket__clock num">{mmss(left)}</span>
          <span className="pl-ticket__timerLabel">
            {urgent ? 'Show this at the counter now' : 'Show this at the counter'}
          </span>
        </div>
      )}
    </div>
  );
}
