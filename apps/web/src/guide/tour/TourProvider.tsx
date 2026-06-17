import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { Tour } from './types';
import { TOURS } from './tours';
import { TourOverlay } from './TourOverlay';

type TourCtx = {
  /** Launch a tour by id (from TOURS). No-op if unknown. */
  startTour: (id: string) => void;
  stop: () => void;
  /** Currently running tour, or null. */
  active: Tour | null;
};

const Ctx = createContext<TourCtx | null>(null);

export function useTour(): TourCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTour must be used within <TourProvider>');
  return ctx;
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<Tour | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  const startTour = useCallback((id: string) => {
    const tour = TOURS.find((t) => t.id === id);
    if (!tour) return;
    setActive(tour);
    setStepIndex(0);
  }, []);

  const stop = useCallback(() => setActive(null), []);

  const next = useCallback(() => {
    setStepIndex((i) => {
      if (!active) return i;
      if (i + 1 >= active.steps.length) {
        setActive(null);
        return 0;
      }
      return i + 1;
    });
  }, [active]);

  const back = useCallback(() => setStepIndex((i) => Math.max(0, i - 1)), []);

  // Drive route changes from the active step so a tour can walk across pages.
  const step = active?.steps[stepIndex];
  useEffect(() => {
    if (step?.route && location.pathname !== step.route) {
      navigate(step.route);
    }
    // Only react to the step changing, not every location change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const value = useMemo<TourCtx>(() => ({ startTour, stop, active }), [startTour, stop, active]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {active && step && (
        <TourOverlay
          step={step}
          stepIndex={stepIndex}
          total={active.steps.length}
          pathname={location.pathname}
          onNext={next}
          onBack={back}
          onStop={stop}
        />
      )}
    </Ctx.Provider>
  );
}

/**
 * A one-time nudge for first-run users. Returns whether the nudge for `key`
 * should still be shown, plus a dismisser that records it as seen.
 */
export function useOnceNudge(key: string): [boolean, () => void] {
  const storageKey = `goserve.nudge.${key}`;
  const [show, setShow] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== 'done';
    } catch {
      return false;
    }
  });
  const seenRef = useRef(false);
  const dismiss = useCallback(() => {
    if (seenRef.current) return;
    seenRef.current = true;
    try {
      localStorage.setItem(storageKey, 'done');
    } catch {
      /* ignore */
    }
    setShow(false);
  }, [storageKey]);
  return [show, dismiss];
}
