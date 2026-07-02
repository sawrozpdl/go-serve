/**
 * AppSheet behavior against the visibility-faithful gorhom mock (jest.setup):
 * open renders content, closed hides it, the X fires onClose, and the
 * controlled-open contract survives reopen cycles.
 */
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
