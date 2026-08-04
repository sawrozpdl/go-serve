/**
 * AppSheet behavior against the visibility-faithful gorhom mock (jest.setup):
 * open renders content, closed hides it, the X fires onClose, and the
 * controlled-open contract survives reopen cycles.
 */
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import { userEvent } from '@testing-library/react-native';
import { renderWithProviders } from '@/test-utils';
import { AppSheet } from '../AppSheet';

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AppSheet open={open} onClose={onClose} title="Record payment">
      <Text>sheet-content</Text>
    </AppSheet>
  );
}

describe('AppSheet', () => {
  it('shows content when open and hides it when closed', async () => {
    const { queryByText, rerender } = await renderWithProviders(
      <Harness open={false} onClose={() => {}} />,
    );
    expect(queryByText('sheet-content')).toBeNull();

    await rerender(<Harness open onClose={() => {}} />);
    expect(queryByText('sheet-content')).toBeTruthy();
    expect(queryByText('Record payment')).toBeTruthy();

    await rerender(<Harness open={false} onClose={() => {}} />);
    expect(queryByText('sheet-content')).toBeNull();
  });

  it('fires onClose from the header close button', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const { getByLabelText } = await renderWithProviders(<Harness open onClose={onClose} />);
    await user.press(getByLabelText('sheet-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the right action and fires it', async () => {
    const user = userEvent.setup();
    const action = jest.fn();
    const { getByLabelText } = await renderWithProviders(
      <AppSheet open onClose={() => {}} title="Menu" rightAction={{ label: 'Done', onPress: action }}>
        <Text>x</Text>
      </AppSheet>,
    );
    await user.press(getByLabelText('sheet-action'));
    expect(action).toHaveBeenCalledTimes(1);
  });
});

/**
 * The sizing contract is the whole bug. An inner AppSheet.ScrollView only scrolls
 * when gorhom's content box has a DEFINITE height, which only the fixed-detent
 * modes give it. A `hug` sheet leaves BottomSheetView and BottomSheetScrollView
 * both writing gorhom's `contentHeight`, so the list renders in full and the drag
 * does nothing — silently. These assert the configuration, not the gesture
 * (jest cannot observe scrolling; that is verified on a device).
 */
describe('AppSheet sizing', () => {
  /** Reads the sizing config the gorhom mock echoes onto a host node. */
  const sizingOf = async (element: ReactElement) => {
    const { getByTestId } = await renderWithProviders(element);
    return JSON.parse(getByTestId('sheet-sizing').props.accessibilityLabel);
  };

  it('hug (the default) uses dynamic sizing and no snap points', async () => {
    expect(
      await sizingOf(
        <AppSheet open onClose={() => {}}>
          <Text>x</Text>
        </AppSheet>,
      ),
    ).toEqual({ enableDynamicSizing: true, snapPoints: null });
  });

  it('medium pins one 60% detent so inner content can scroll', async () => {
    expect(
      await sizingOf(
        <AppSheet open onClose={() => {}} size="medium">
          <Text>x</Text>
        </AppSheet>,
      ),
    ).toEqual({ enableDynamicSizing: false, snapPoints: ['60%'] });
  });

  it('full pins one 100% detent', async () => {
    expect(
      await sizingOf(
        <AppSheet open onClose={() => {}} size="full">
          <Text>x</Text>
        </AppSheet>,
      ),
    ).toEqual({ enableDynamicSizing: false, snapPoints: ['100%'] });
  });

  it('the legacy `full` boolean still means size="full"', async () => {
    expect(
      await sizingOf(
        <AppSheet open onClose={() => {}} full>
          <Text>x</Text>
        </AppSheet>,
      ),
    ).toEqual({ enableDynamicSizing: false, snapPoints: ['100%'] });
  });

});

/** The one test that would have caught BOTH real defects: the settle flow's
 *  credit-account picker, and MoveTableSheet before commit e8f81f6. */
describe('AppSheet scrollable-in-hug tripwire', () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it('shouts when AppSheet.ScrollView is used in a hug sheet', async () => {
    await renderWithProviders(
      <AppSheet open onClose={() => {}}>
        <AppSheet.ScrollView>
          <Text>rows</Text>
        </AppSheet.ScrollView>
      </AppSheet>,
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('cannot scroll inside a size="hug"'));
  });

  it('stays quiet for medium, full, and non-scrolling children', async () => {
    for (const size of ['medium', 'full'] as const) {
      await renderWithProviders(
        <AppSheet open onClose={() => {}} size={size}>
          <AppSheet.ScrollView>
            <Text>rows</Text>
          </AppSheet.ScrollView>
        </AppSheet>,
      );
    }
    await renderWithProviders(
      <AppSheet open onClose={() => {}}>
        <Text>a short form</Text>
      </AppSheet>,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
