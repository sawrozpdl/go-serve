import { useState } from 'react';
import { Gift, X } from 'lucide-react';

import { formatNPR } from '@/components/Money';
import { hasFeature, useMe } from '@/lib/api';
import { lookupRewardCode, useRedeemRewardCode, type RewardLookup } from '@/lib/engage';
import { usePermissions } from '@/lib/permissions';
import { useTenant } from '@/lib/tenant';

// =========================================================================
// The till end of QR rewards.
//
// A guest shows a code with a live countdown; the cashier types it here while
// the tab is still open. Two deliberate choices:
//
//   * LOOK UP FIRST, apply on a second explicit tap. Same discipline as
//     DiscountModal — nothing that moves money happens while someone is still
//     typing. The preview shows the amount AFTER clamping, so what the cashier
//     is shown is what actually comes off.
//   * every error is a sentence, never an error kind. A cashier reads these
//     with a guest standing in front of them.
// =========================================================================

/** Turns the server's error codes into something a cashier can act on. */
function humanError(code: string, message: string): string {
  switch (code) {
    case 'code_not_found':
      return "That code isn't recognised — check the spelling.";
    case 'code_already_redeemed':
      return message || 'That code has already been used.';
    case 'code_expired':
      return 'That code has expired.';
    case 'code_void':
      return 'That code was cancelled.';
    case 'order_not_open':
      return 'This tab is already settled — a reward has to go on before it closes.';
    case 'order_already_has_reward':
      return 'This tab already has a reward on it.';
    case 'discount_exceeds_bill':
      return 'This tab is already fully discounted.';
    case 'reward_not_applicable':
      return message;
    default:
      return message || 'Could not apply that code.';
  }
}

export function RewardCodeField({ orderId }: { orderId: string }) {
  const me = useMe();
  const { can } = usePermissions();
  const { slug } = useTenant();
  const redeem = useRedeemRewardCode();

  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<RewardLookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Invisible unless the café has the feature AND this member may redeem.
  if (!hasFeature(me.data, 'qr_rewards') || !can('engage:redeem')) return null;

  const reset = () => {
    setOpen(false);
    setCode('');
    setPreview(null);
    setError('');
  };

  const check = async () => {
    if (!code.trim() || !slug) return;
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const found = await lookupRewardCode(code.trim(), orderId, slug);
      setPreview(found);
      if (!found.redeemable) setError(found.blocked_reason ?? 'That code cannot be used here.');
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setError(humanError(err.code ?? '', err.message ?? ''));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      await redeem.mutateAsync({ code: code.trim(), orderId });
      reset();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setError(humanError(err.code ?? '', err.message ?? ''));
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="discount-add" onClick={() => setOpen(true)}>
        <Gift size={14} strokeWidth={1.8} />
        Reward code
      </button>
    );
  }

  return (
    <div className="reward-code">
      <div className="reward-code__head">
        <span className="reward-code__title">Reward code</span>
        <button type="button" className="btn icon" aria-label="close" onClick={reset}>
          <X size={13} strokeWidth={1.6} />
        </button>
      </div>

      <div className="reward-code__row">
        <input
          className="reward-code__input num"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setPreview(null);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void (preview?.redeemable ? apply() : check());
            }
          }}
          placeholder="TEA-7K2M"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          aria-label="Reward code"
        />
        {!preview?.redeemable ? (
          <button type="button" className="btn" onClick={() => void check()} disabled={busy || !code.trim()}>
            {busy ? 'Checking…' : 'Check'}
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={() => void apply()} disabled={busy}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
        )}
      </div>

      {preview?.redeemable && (
        <div className="reward-code__preview">
          <div className="reward-code__label">{preview.label}</div>
          {preview.applies_cents !== undefined && (
            <div className="reward-code__amt">
              −{formatNPR(preview.applies_cents)}
              {preview.would_clamp && (
                // Say so rather than silently giving less than the code promises.
                <span className="reward-code__note"> (capped at the bill total)</span>
              )}
            </div>
          )}
          {preview.needs_grace_override && (
            // The guest is not being punished for the café's own queue, but the
            // cashier is told what they are doing.
            <div className="reward-code__grace">
              Expired {Math.abs(Math.round(preview.seconds_left / 60))} min ago — applying it will be
              recorded as an override.
            </div>
          )}
        </div>
      )}

      {error && <div className="reward-code__error">{error}</div>}
    </div>
  );
}
