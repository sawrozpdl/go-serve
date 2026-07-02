/**
 * Component tests for the Phase-1 redesign primitives: behavior + a11y
 * contracts (callbacks, clamping, states), not pixel styling. State-changing
 * interactions go through userEvent (async act — house convention).
 */
import { userEvent } from '@testing-library/react-native';
import { renderWithProviders } from '@/test-utils';
import { Stamp } from '../Stamp';
import { Stepper } from '../Stepper';
import { ErrorState } from '../ErrorState';
import { EmptyState } from '../EmptyState';
import { ListRow } from '../ListRow';
import { Chip } from '../Chip';
import { Skeleton } from '../Skeleton';
import { Stat } from '../Stat';

describe('Stamp', () => {
  it('renders its label for every tone', async () => {
    const tones = ['neutral', 'info', 'warn', 'success', 'danger', 'brand'] as const;
    for (const tone of tones) {
      const { getByLabelText, unmount } = await renderWithProviders(
        <Stamp label={tone} tone={tone} />,
      );
      expect(getByLabelText(tone)).toBeTruthy();
      await unmount();
    }
  });
});

describe('Stepper', () => {
  it('fires increment/decrement and clamps at min', async () => {
    const user = userEvent.setup();
    const inc = jest.fn();
    const dec = jest.fn();
    const { getByLabelText, rerender } = await renderWithProviders(
      <Stepper value={2} onIncrement={inc} onDecrement={dec} label="Cappuccino" />,
    );
    await user.press(getByLabelText('increase Cappuccino'));
    await user.press(getByLabelText('decrease Cappuccino'));
    expect(inc).toHaveBeenCalledTimes(1);
    expect(dec).toHaveBeenCalledTimes(1);

    // At min the decrement is disabled and does not fire.
    await rerender(<Stepper value={0} onIncrement={inc} onDecrement={dec} label="Cappuccino" />);
    await user.press(getByLabelText('decrease Cappuccino'));
    expect(dec).toHaveBeenCalledTimes(1);
  });

  it('clamps at max', async () => {
    const user = userEvent.setup();
    const inc = jest.fn();
    const { getByLabelText } = await renderWithProviders(
      <Stepper value={5} max={5} onIncrement={inc} onDecrement={() => {}} />,
    );
    await user.press(getByLabelText('increase'));
    expect(inc).not.toHaveBeenCalled();
  });

  it('shows the current quantity', async () => {
    const { getByLabelText } = await renderWithProviders(
      <Stepper value={7} onIncrement={() => {}} onDecrement={() => {}} />,
    );
    expect(getByLabelText('quantity 7')).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('renders default copy, detail and fires retry', async () => {
    const user = userEvent.setup();
    const retry = jest.fn();
    const { getByText } = await renderWithProviders(
      <ErrorState detail="Network request failed" onRetry={retry} />,
    );
    expect(getByText("Couldn't load this")).toBeTruthy();
    expect(getByText('Network request failed')).toBeTruthy();
    await user.press(getByText('Try again'));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('EmptyState', () => {
  it('renders title, hint and action', async () => {
    const user = userEvent.setup();
    const act = jest.fn();
    const { getByText } = await renderWithProviders(
      <EmptyState
        title="Nothing cooking"
        hint="Fire an order first."
        action={{ label: 'Open floor', onPress: act }}
      />,
    );
    expect(getByText('Nothing cooking')).toBeTruthy();
    await user.press(getByText('Open floor'));
    expect(act).toHaveBeenCalledTimes(1);
  });
});

describe('ListRow', () => {
  it('renders title/subtitle/value and fires onPress', async () => {
    const user = userEvent.setup();
    const press = jest.fn();
    const { getByText } = await renderWithProviders(
      <ListRow title="Cash drawer" subtitle="since 9:00" value="Rs 8,240" chevron onPress={press} />,
    );
    expect(getByText('Cash drawer')).toBeTruthy();
    expect(getByText('since 9:00')).toBeTruthy();
    await user.press(getByText('Cash drawer'));
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('renders as a plain row without onPress', async () => {
    const { getByText } = await renderWithProviders(<ListRow title="Version" value="1.0.0" />);
    expect(getByText('Version')).toBeTruthy();
    expect(getByText('1.0.0')).toBeTruthy();
  });
});

describe('Chip', () => {
  it('reflects selection state and fires onPress', async () => {
    const user = userEvent.setup();
    const press = jest.fn();
    const { getByLabelText } = await renderWithProviders(
      <Chip label="Espresso" count={3} selected onPress={press} />,
    );
    const chip = getByLabelText('Espresso');
    expect(chip.props.accessibilityState.selected).toBe(true);
    await user.press(chip);
    expect(press).toHaveBeenCalledTimes(1);
  });
});

describe('Skeleton + Stat', () => {
  it('Skeleton renders with the loading label', async () => {
    const { getAllByLabelText } = await renderWithProviders(<Skeleton width={100} height={12} />);
    expect(getAllByLabelText('loading').length).toBe(1);
  });

  it('Stat shows the value, or a skeleton while loading', async () => {
    const { getByText, rerender, queryByText, getAllByLabelText } = await renderWithProviders(
      <Stat label="Sales" value="Rs 12,480" />,
    );
    expect(getByText('Rs 12,480')).toBeTruthy();
    await rerender(<Stat label="Sales" value="Rs 12,480" loading />);
    expect(queryByText('Rs 12,480')).toBeNull();
    expect(getAllByLabelText('loading').length).toBeGreaterThan(0);
  });
});
