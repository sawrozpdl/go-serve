import { Linking } from 'react-native';
import { screen, userEvent } from '@testing-library/react-native';
import { renderWithProviders } from '@/test-utils';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn() }) }));

// eslint-disable-next-line import/first -- import after jest.mock()
import Contact from '../contact';

describe('Contact', () => {
  it('lists the support team', async () => {
    await renderWithProviders(<Contact />);
    expect(screen.getByText('Saroj')).toBeOnTheScreen();
    expect(screen.getByText('Sudip')).toBeOnTheScreen();
    expect(screen.getByText('Asmin')).toBeOnTheScreen();
  });

  it('opens a mailto when Email is pressed', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const user = userEvent.setup();
    await renderWithProviders(<Contact />);
    // Sudip has a fixed email; press the first Email button and assert a mailto fires.
    await user.press(screen.getAllByText('Email')[0]);
    expect(openURL).toHaveBeenCalledWith(expect.stringContaining('mailto:'));
    openURL.mockRestore();
  });

  it('opens a tel when Call is pressed', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const user = userEvent.setup();
    await renderWithProviders(<Contact />);
    await user.press(screen.getAllByText('Call')[0]);
    expect(openURL).toHaveBeenCalledWith(expect.stringContaining('tel:'));
    openURL.mockRestore();
  });
});
