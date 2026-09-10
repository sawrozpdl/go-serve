/**
 * Grid's first paint. It used to render NOTHING until `onLayout` gave it a
 * width, which cost a blank frame on every mount and left the grid
 * permanently empty anywhere onLayout never fires.
 */
import { View } from 'react-native';
import { screen, fireEvent } from '@testing-library/react-native';
import { renderWithProviders } from '@/test-utils';
import { AppText } from '@/components/ui/Text';
import { Grid } from '../Grid';

describe('Grid', () => {
  it('shows its children before it has been measured', async () => {
    await renderWithProviders(
      <Grid columns={3} testID="g">
        <AppText>One</AppText>
        <AppText>Two</AppText>
      </Grid>,
    );
    expect(screen.getByText('One')).toBeOnTheScreen();
    expect(screen.getByText('Two')).toBeOnTheScreen();
  });

  it('keeps them once a width arrives, and divides it into columns', async () => {
    await renderWithProviders(
      <Grid columns={2} gap={10} testID="g">
        <AppText>One</AppText>
        <AppText>Two</AppText>
      </Grid>,
    );
    fireEvent(screen.getByTestId('g'), 'layout', {
      nativeEvent: { layout: { width: 410, height: 100, x: 0, y: 0 } },
    });
    // (410 − 10 gap) / 2, floored — rounding UP overflows the last item onto
    // its own row and collapses the grid to one column.
    expect(screen.getByText('One')).toBeOnTheScreen();
    expect(screen.getByText('Two')).toBeOnTheScreen();
  });

  it('skips null children rather than rendering empty cells', async () => {
    await renderWithProviders(
      <Grid columns={2} testID="g">
        <AppText>One</AppText>
        {null}
        <View testID="third" />
      </Grid>,
    );
    expect(screen.getByText('One')).toBeOnTheScreen();
    expect(screen.getByTestId('third')).toBeOnTheScreen();
  });
});
