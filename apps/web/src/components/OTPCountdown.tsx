import { useEffect, useState } from 'react';

type Props = {
  /** Seconds remaining. The component owns its own ticking clock. */
  seconds: number;
  /** Called when the user clicks resend after the timer reaches zero. */
  onResend: () => void;
  disabled?: boolean;
};

// Renders one of two states: a muted "resend in 0:47" chip while the timer
// is still running, or an active "resend code" link button once it hits 0.
// The starting value comes from the server's resend_in_seconds field so the
// FE never has to guess the cooldown — it just counts down to it.
export function OTPCountdown({ seconds, onResend, disabled }: Props) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    setRemaining(seconds);
  }, [seconds]);

  useEffect(() => {
    if (remaining <= 0) return;
    const t = window.setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0));
    }, 1000);
    return () => window.clearInterval(t);
  }, [remaining]);

  if (remaining > 0) {
    const mm = Math.floor(remaining / 60);
    const ss = String(remaining % 60).padStart(2, '0');
    return (
      <span className="otp-resend muted">
        resend in {mm}:{ss}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="otp-resend link"
      onClick={onResend}
      disabled={disabled}
    >
      resend code
    </button>
  );
}
