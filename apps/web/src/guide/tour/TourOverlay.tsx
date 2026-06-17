import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { TourStep } from './types';

type Props = {
  step: TourStep;
  stepIndex: number;
  total: number;
  /** Current route — re-locate the target after a step-driven navigation. */
  pathname: string;
  onNext: () => void;
  onBack: () => void;
  onStop: () => void;
};

const PAD = 6;

/**
 * Renders the spotlight (a dim backdrop with a hole over the target) plus the
 * coachmark card. Locates the target by selector with a short retry so it
 * survives the navigation a step may trigger; falls back to a centered card
 * when there's no target or it can't be found.
 */
export function TourOverlay({ step, stepIndex, total, pathname, onNext, onBack, onStop }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Locate the target (with retries) whenever the step or route changes.
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let timer: number | undefined;

    const measure = (el: Element) => setRect(el.getBoundingClientRect());

    const locate = () => {
      if (cancelled) return;
      if (!step.target) {
        setRect(null);
        return;
      }
      const el = document.querySelector(step.target);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        // Let the scroll settle before measuring.
        window.setTimeout(() => !cancelled && measure(el), 220);
        return;
      }
      if (tries++ < 24) {
        timer = window.setTimeout(locate, 80);
      } else {
        setRect(null); // give up → centered card
      }
    };

    setRect(null);
    locate();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [step, pathname]);

  // Keep the spotlight glued to the target while scrolling / resizing.
  useEffect(() => {
    if (!step.target) return;
    const update = () => {
      const el = document.querySelector(step.target!);
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [step]);

  // Keyboard controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onStop();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') onNext();
      else if (e.key === 'ArrowLeft') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNext, onBack, onStop]);

  const last = stepIndex + 1 >= total;

  // Coachmark placement: centered when no target, else below the target (or
  // above when there isn't room below).
  let cardStyle: React.CSSProperties;
  if (!rect) {
    cardStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  } else {
    const below = rect.bottom + 220 < window.innerHeight;
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - 332);
    cardStyle = below
      ? { top: rect.bottom + 12, left }
      : { bottom: window.innerHeight - rect.top + 12, left };
  }

  return createPortal(
    <div className="tour" role="dialog" aria-modal="true" aria-label="Guided walkthrough">
      {/* Click-catcher: blocks page interaction during the tour. Dims itself only
          when there's no spotlight (the spotlight's own shadow dims otherwise). */}
      <div
        className={`tour__backdrop${rect ? '' : ' tour__backdrop--dim'}`}
        onClick={onStop}
      />
      {rect && (
        <div
          className="tour__spotlight"
          style={{
            left: rect.left - PAD,
            top: rect.top - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
          }}
        />
      )}
      <div className="tour__card" style={cardStyle}>
        <div className="tour__step">
          Step {stepIndex + 1} of {total}
        </div>
        <h3 className="tour__title">{step.title}</h3>
        <div className="tour__body">{step.body}</div>
        <div className="tour__actions">
          <button type="button" className="tour__skip" onClick={onStop}>
            Skip
          </button>
          <div className="tour__nav">
            {stepIndex > 0 && (
              <button type="button" className="btn small" onClick={onBack}>
                Back
              </button>
            )}
            <button type="button" className="btn small primary" onClick={onNext}>
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
