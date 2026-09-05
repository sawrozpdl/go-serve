/**
 * The bottom bar's order is asserted by TabBar itself, not inherited from
 * expo-router. The framework derives the navigator's route order from the file
 * tree, so the sequence of <Tabs.Screen> elements in (app)/_layout.tsx does not
 * control what the bar looks like — renaming a route file would silently
 * reshuffle the tabs. These tests are what make that guarantee real.
 */
import type { ComponentProps } from 'react';
import { renderWithProviders } from '@/test-utils';
import { TabBar } from '../TabBar';

type Props = ComponentProps<typeof TabBar>;

type Route = { key: string; name: string };

function harness(names: string[], hidden: string[] = []): Props {
  const routes: Route[] = names.map((name) => ({ key: `${name}-key`, name }));
  const descriptors = Object.fromEntries(
    routes.map((r) => [
      r.key,
      {
        options: {
          title: r.name[0].toUpperCase() + r.name.slice(1),
          href: hidden.includes(r.name) ? null : `/(app)/${r.name}`,
          tabBarIcon: () => null,
        },
      },
    ]),
  );
  return {
    state: { routes, index: 0 },
    descriptors,
    navigation: { emit: () => ({ defaultPrevented: false }), navigate: () => {} },
  } as unknown as Props;
}

// The file-tree order expo-router actually hands us is alphabetical, which is
// exactly the order the bar must NOT render in.
const FILE_TREE_ORDER = ['dashboard', 'floor', 'history', 'kitchen', 'more'];

describe('TabBar ordering', () => {
  it('renders Dashboard | Kitchen | Floor | History | More, whatever order the routes arrive in', async () => {
    const props = harness(FILE_TREE_ORDER);
    const { getAllByRole } = await renderWithProviders(
      <TabBar {...props} />,
    );
    const labels = getAllByRole('tab').map((t) => t.props.accessibilityLabel);
    expect(labels).toEqual(['Dashboard', 'Kitchen', 'Floor', 'History', 'More']);
  });

  it('drops a tab the member cannot see, keeping the rest in order', async () => {
    // A waiter has no report:read, so _layout sets the dashboard href to null.
    const props = harness(FILE_TREE_ORDER, ['dashboard']);
    const { getAllByRole } = await renderWithProviders(
      <TabBar {...props} />,
    );
    const labels = getAllByRole('tab').map((t) => t.props.accessibilityLabel);
    expect(labels).toEqual(['Kitchen', 'Floor', 'History', 'More']);
  });

  it('sorts an unknown route to the end rather than dropping it', async () => {
    const props = harness([...FILE_TREE_ORDER, 'newthing']);
    const { getAllByRole } = await renderWithProviders(
      <TabBar {...props} />,
    );
    const labels = getAllByRole('tab').map((t) => t.props.accessibilityLabel);
    expect(labels[labels.length - 1]).toBe('Newthing');
  });
});
