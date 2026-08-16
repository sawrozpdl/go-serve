import { screen, userEvent } from '@testing-library/react-native';
import type { KitchenTicket } from '@cafe-mgmt/api-types';
import { renderWithProviders } from '@/test-utils';
import { TicketCard } from '../TicketCard';

const base: KitchenTicket = {
  item_id: 'i1',
  order_id: 'o1',
  table_label: 'T1',
  menu_item_name: 'Cappuccino',
  qty: 2,
  modifiers: null,
  notes: '',
  kitchen_status: 'in_progress',
  sent_to_kitchen_at: new Date().toISOString(),
  ready_at: null,
};

describe('TicketCard', () => {
  it('renders an in-progress ticket with a Mark ready action', async () => {
    await renderWithProviders(
      <TicketCard ticket={base} now={Date.now()} canAct busy={false} onAction={jest.fn()} />,
    );
    expect(screen.getByText('Cappuccino')).toBeOnTheScreen();
    expect(screen.getByText('2×')).toBeOnTheScreen();
    expect(screen.getByText('T1')).toBeOnTheScreen();
    expect(screen.getByText('Mark ready')).toBeOnTheScreen();
  });

  it('fires onAction when the action is pressed', async () => {
    const user = userEvent.setup();
    const onAction = jest.fn();
    await renderWithProviders(
      <TicketCard ticket={base} now={Date.now()} canAct busy={false} onAction={onAction} />,
    );
    await user.press(screen.getByText('Mark ready'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('renders a ready ticket with the Ready stamp, add-ons and notes', async () => {
    const t: KitchenTicket = {
      ...base,
      kitchen_status: 'ready',
      ready_at: new Date().toISOString(),
      // Real add-on rows (0062). This used to assert the speculative
      // `modifiers` jsonb, which no client ever wrote — so the card's add-on
      // rendering was only ever exercised by data that never existed.
      add_ons: [
        {
          id: 'a1',
          modifier_id: 'm1',
          group_name: 'Milk',
          name: 'Oat milk',
          price_cents: 3000,
          cost_cents: 0,
          qty: 1,
        },
        {
          id: 'a2',
          modifier_id: 'm2',
          group_name: 'Extras',
          name: 'Shot',
          price_cents: 6000,
          cost_cents: 0,
          qty: 2,
        },
      ],
      notes: 'extra hot',
    };
    await renderWithProviders(
      <TicketCard ticket={t} now={Date.now()} canAct busy={false} onAction={jest.fn()} />,
    );
    expect(screen.getByText('Ready')).toBeOnTheScreen();
    expect(screen.getByText('Mark served')).toBeOnTheScreen();
    // Add-ons print under the dish; a doubled one shows its count.
    expect(screen.getByText(/Oat milk/)).toBeOnTheScreen();
    expect(screen.getByText(/2× ?Shot/)).toBeOnTheScreen();
    expect(screen.getByText('» extra hot')).toBeOnTheScreen();
  });

  it('shows read-only status when the user cannot act', async () => {
    await renderWithProviders(
      <TicketCard ticket={base} now={Date.now()} canAct={false} busy={false} onAction={jest.fn()} />,
    );
    expect(screen.getByText('Cooking')).toBeOnTheScreen();
  });
});
