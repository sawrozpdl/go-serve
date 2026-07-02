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

  it('renders a ready ticket with the Ready stamp, modifiers and notes', async () => {
    const t: KitchenTicket = {
      ...base,
      kitchen_status: 'ready',
      ready_at: new Date().toISOString(),
      modifiers: { milk: 'oat' },
      notes: 'extra hot',
    };
    await renderWithProviders(
      <TicketCard ticket={t} now={Date.now()} canAct busy={false} onAction={jest.fn()} />,
    );
    expect(screen.getByText('Ready')).toBeOnTheScreen();
    expect(screen.getByText('Mark served')).toBeOnTheScreen();
    expect(screen.getByText('+ milk: oat')).toBeOnTheScreen();
    expect(screen.getByText('» extra hot')).toBeOnTheScreen();
  });

  it('shows read-only status when the user cannot act', async () => {
    await renderWithProviders(
      <TicketCard ticket={base} now={Date.now()} canAct={false} busy={false} onAction={jest.fn()} />,
    );
    expect(screen.getByText('Cooking')).toBeOnTheScreen();
  });
});
