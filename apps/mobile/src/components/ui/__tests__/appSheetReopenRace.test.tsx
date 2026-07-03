/**
 * Regression for the "void a second item does nothing until you leave and
 * re-enter the tab" bug: real gorhom dismiss() animates asynchronously, so
 * flipping `open` false→true (close one sheet, immediately open the next)
 * before that animation's onDismiss fires must still end up presented. The
 * shared jest.setup mock resolves dismiss() synchronously, which can't catch
 * this, so this file overrides it with an async-dismiss double.
 */
import { Text } from 'react-native';
import { waitFor } from '@testing-library/react-native';
import { renderWithProviders } from '@/test-utils';
import { AppSheet } from '../AppSheet';

jest.mock('@gorhom/bottom-sheet', () => {
  /* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
  const actual = require('@gorhom/bottom-sheet/mock');
  const React = require('react');
  /* eslint-enable @typescript-eslint/no-require-imports */

  class BottomSheetModal extends React.Component {
    state = { visible: false };
    dismissing = false;
    present = () => {
      // Matches the real gorhom quirk this regression targets: present()
      // called while a close animation is still in flight is swallowed.
      if (this.dismissing) return;
      this.setState({ visible: true });
    };
    dismiss = () => {
      if (!this.state.visible || this.dismissing) return;
      this.dismissing = true;
      // Simulate the real close animation: visibility + onDismiss land on a
      // later tick, not synchronously inside dismiss().
      setTimeout(() => {
        this.dismissing = false;
        this.setState({ visible: false });
        (this.props as { onDismiss?: () => void }).onDismiss?.();
      }, 10);
    };
    close = this.dismiss;
    forceClose = this.dismiss;
    snapToIndex() {}
    snapToPosition() {}
    expand() {}
    collapse() {}
    render() {
      if (!this.state.visible) return null;
      const kids = this.props.children;
      return typeof kids === 'function' ? kids({ data: undefined }) : kids;
    }
  }

  return { ...actual, BottomSheetModal };
});

// One stable component/position across rerenders — swapping `open`/`label`
// as props (as the real void-then-void-again flow does via useState) rather
// than swapping element types, which would remount AppSheet and trivially
// reset all its refs instead of exercising the race.
function Harness({ open, label, onClose }: { open: boolean; label: string; onClose: () => void }) {
  return (
    <AppSheet open={open} onClose={onClose}>
      <Text>{label}</Text>
    </AppSheet>
  );
}

describe('AppSheet reopen race', () => {
  it('reopens with new content when closed and immediately reopened, before the close animation settles', async () => {
    const { queryByText, rerender } = await renderWithProviders(
      <Harness open label="item-a" onClose={() => {}} />,
    );
    expect(queryByText('item-a')).toBeTruthy();

    // Close (starts the async dismiss) then immediately request reopen with
    // different content, before the animation's onDismiss has fired.
    await rerender(<Harness open={false} label="item-a" onClose={() => {}} />);
    await rerender(<Harness open label="item-b" onClose={() => {}} />);

    // Let the in-flight dismiss animation actually finish.
    await waitFor(() => expect(queryByText('item-b')).toBeTruthy());
  });
});
