import { Component, type ReactNode } from 'react';
import { Text, Pressable, useColorScheme } from 'react-native';
import { render, userEvent } from '@testing-library/react-native';
import { ThemeProvider } from '../ThemeProvider';
import { useTheme, useThemeContext } from '../useTheme';
import { INK_SCALE_LIGHT_V2, INK_SCALE_DARK_V2 } from '@cafe-mgmt/design-tokens';
import { storage } from '../../lib/kv';

jest.mock('react-native/Libraries/Utilities/useColorScheme');
const mockedUseColorScheme = useColorScheme as jest.Mock;

function Probe() {
  const theme = useTheme();
  const { preference, setPreference } = useThemeContext();
  return (
    <>
      <Text testID="bg">{theme.colors.bg}</Text>
      <Text testID="pref">{preference}</Text>
      <Pressable testID="to-light" onPress={() => setPreference('light')}>
        <Text>light</Text>
      </Pressable>
    </>
  );
}

class Boundary extends Component<{ children: ReactNode; onError: (e: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

beforeEach(() => {
  storage.clearAll();
  mockedUseColorScheme.mockReturnValue('dark');
});

describe('ThemeProvider', () => {
  it('follows the OS scheme when preference is system', async () => {
    mockedUseColorScheme.mockReturnValue('light');
    const { getByTestId } = await render(
      <ThemeProvider initialPreference="system">
        <Probe />
      </ThemeProvider>,
    );
    expect(getByTestId('bg')).toHaveTextContent(INK_SCALE_LIGHT_V2[1000]);
  });

  it('honors an explicit dark preference over a light OS scheme', async () => {
    mockedUseColorScheme.mockReturnValue('light');
    const { getByTestId } = await render(
      <ThemeProvider initialPreference="dark">
        <Probe />
      </ThemeProvider>,
    );
    expect(getByTestId('bg')).toHaveTextContent(INK_SCALE_DARK_V2[1000]);
  });

  it('treats a null OS scheme as dark', async () => {
    mockedUseColorScheme.mockReturnValue(null);
    const { getByTestId } = await render(
      <ThemeProvider initialPreference="system">
        <Probe />
      </ThemeProvider>,
    );
    expect(getByTestId('bg')).toHaveTextContent(INK_SCALE_DARK_V2[1000]);
  });

  it('persists a preference change and re-themes', async () => {
    const user = userEvent.setup();
    const { getByTestId } = await render(
      <ThemeProvider initialPreference="dark">
        <Probe />
      </ThemeProvider>,
    );
    await user.press(getByTestId('to-light'));
    expect(getByTestId('pref')).toHaveTextContent('light');
    expect(getByTestId('bg')).toHaveTextContent(INK_SCALE_LIGHT_V2[1000]);
    expect(storage.getString('theme.override')).toBe('light');
  });

  it('reads a persisted preference from storage on mount', async () => {
    storage.set('theme.override', 'light');
    const { getByTestId } = await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(getByTestId('pref')).toHaveTextContent('light');
  });

  it('defaults to system when stored value is invalid', async () => {
    storage.set('theme.override', 'garbage');
    const { getByTestId } = await render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(getByTestId('pref')).toHaveTextContent('system');
  });
});

describe('useTheme outside provider', () => {
  it('throws a helpful error', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let caught: Error | null = null;
    function Bare() {
      useTheme();
      return null;
    }
    await render(
      <Boundary onError={(e) => (caught = e)}>
        <Bare />
      </Boundary>,
    );
    expect(caught).not.toBeNull();
    expect(caught!.message).toBe('useTheme must be used within a ThemeProvider');
    spy.mockRestore();
  });
});
