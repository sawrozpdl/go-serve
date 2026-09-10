/**
 * The Undo affordance. On a POS the alternative to a five-second window is a
 * confirm on every destructive tap, and a confirm on a tap you make forty
 * times a service is worse than the mistake it prevents.
 */
import { useToasts, toast } from '../toast';

beforeEach(() => {
  useToasts.setState({ items: [] });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('toast.undo', () => {
  it('carries a one-shot action', () => {
    const onUndo = jest.fn();
    toast.undo('Line removed', onUndo);

    const item = useToasts.getState().items[0];
    expect(item.action?.label).toBe('Undo');
    item.action?.onPress();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('lingers longer than a plain toast — 3.5s is not long enough to notice a mistake', () => {
    toast.undo('Line removed', jest.fn());
    toast.success('Saved');

    jest.advanceTimersByTime(4000);
    // The plain one is gone, the actionable one is still there.
    expect(useToasts.getState().items.map((i) => i.title)).toEqual(['Line removed']);

    jest.advanceTimersByTime(4000);
    expect(useToasts.getState().items).toHaveLength(0);
  });

  it('leaves ordinary toasts without an action', () => {
    toast.success('Saved');
    toast.error('Nope');
    expect(useToasts.getState().items.every((i) => i.action === undefined)).toBe(true);
  });
});
