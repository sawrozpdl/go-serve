/**
 * Structural guard for the FAB's hit target. The button shipped un-tappable
 * because `position: 'absolute'` was handed to PressableScale's `style`, which
 * lands on its INNER animated view — leaving the outer Pressable a 0-height box
 * with the circle drawn outside its own hit-test bounds. Neither Android's
 * TouchTargetHelper nor iOS's hitTest: recurses into that, so no tap ever
 * reached onPress.
 *
 * `fireEvent.press` / `userEvent.press` call the handler directly and never
 * exercise layout, so a behavioural test cannot catch this. What we can pin is
 * the invariant: the absolute positioning must sit on an ANCESTOR of the
 * touchable, never on or inside it.
 */
import { StyleSheet, View } from 'react-native';
import { userEvent, type RenderResult } from '@testing-library/react-native';
import { renderWithProviders } from '@/test-utils';
import { Fab } from '../Fab';

/** RNTL 14 doesn't re-export its node type, so derive it from a query. */
type HostNode = ReturnType<RenderResult['getByLabelText']>;

function ancestorsOf(node: HostNode): HostNode[] {
  const out: HostNode[] = [];
  for (let p = node.parent; p; p = p.parent) out.push(p);
  return out;
}

const positionOf = (node: HostNode) =>
  (StyleSheet.flatten(node.props?.style) as { position?: string } | undefined)?.position;

describe('Fab', () => {
  it('positions itself on a box-none ancestor, not on the touch target', async () => {
    const { getByLabelText } = await renderWithProviders(
      <Fab icon={<View />} accessibilityLabel="new-walkin" onPress={jest.fn()} />,
    );
    const button = getByLabelText('new-walkin');

    // The anchor: absolutely positioned, and transparent to touches so the list
    // underneath still scrolls.
    const anchor = ancestorsOf(button).find((n) => n.props?.pointerEvents === 'box-none');
    expect(anchor).toBeTruthy();
    expect(positionOf(anchor!)).toBe('absolute');

    // The touchable itself must stay in normal flow so its bounds wrap the
    // circle — this is the assertion that fails if the bug comes back.
    expect(positionOf(button)).toBeUndefined();
    for (const child of button.children) {
      if (typeof child !== 'object') continue;
      expect(positionOf(child as HostNode)).toBeUndefined();
    }
  });

  it('fires onPress', async () => {
    const user = userEvent.setup();
    const press = jest.fn();
    const { getByLabelText } = await renderWithProviders(
      <Fab icon={<View />} accessibilityLabel="new-walkin" onPress={press} />,
    );
    await user.press(getByLabelText('new-walkin'));
    expect(press).toHaveBeenCalledTimes(1);
  });
});
