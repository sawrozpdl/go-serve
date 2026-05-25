import { useEffect, useRef } from 'react';

type Props = {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Fires when the input reaches `length` digits — used to auto-submit. */
  onComplete?: (code: string) => void;
};

// Single text input rather than N separate boxes — paste-friendly, plays
// nicely with iOS Safari's one-time-code autofill, and a screen reader only
// has to announce one field. Strips non-digits on the fly and clamps to
// `length`.
export function OTPInput({
  value,
  onChange,
  length = 6,
  disabled,
  autoFocus,
  onComplete,
}: Props) {
  const ref = useRef<HTMLInputElement | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    if (autoFocus && ref.current) ref.current.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (value.length === length && !firedRef.current) {
      firedRef.current = true;
      onComplete?.(value);
    }
    if (value.length < length) firedRef.current = false;
  }, [value, length, onComplete]);

  return (
    <input
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern={`\\d{${length}}`}
      maxLength={length}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D+/g, '').slice(0, length);
        onChange(digits);
      }}
      className="otp-input"
      aria-label="One-time code"
      spellCheck={false}
    />
  );
}
