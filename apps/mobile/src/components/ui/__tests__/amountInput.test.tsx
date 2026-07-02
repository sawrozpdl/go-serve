/**
 * AmountInput: typed text → cents via the shared catalog/money parser, quick
 * amounts, and external resets. Interactions via userEvent (async act).
 */
import { userEvent } from '@testing-library/react-native';
import { useState } from 'react';
import { renderWithProviders } from '@/test-utils';
import { AmountInput } from '../AmountInput';

function Harness({ initial = 0, quick }: { initial?: number; quick?: number[] }) {
  const [cents, setCents] = useState(initial);
  return (
    <AmountInput
      label="Amount"
      valueCents={cents}
      onChangeCents={setCents}
      quickAmounts={quick}
      formatAmount={(c) => `Rs ${c / 100}`}
      testID="amount"
    />
  );
}

describe('AmountInput', () => {
  it('parses typed text to cents (strips currency noise)', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const { getByTestId } = await renderWithProviders(
      <AmountInput label="Amount" valueCents={0} onChangeCents={onChange} testID="amount" />,
    );
    await user.paste(getByTestId('amount'), 'Rs 1,240.50');
    expect(onChange).toHaveBeenLastCalledWith(124050);
    await user.clear(getByTestId('amount'));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('fills from a quick-amount chip', async () => {
    const user = userEvent.setup();
    const { getByLabelText, getByTestId } = await renderWithProviders(
      <Harness quick={[50000, 70000]} />,
    );
    await user.press(getByLabelText('Rs 700'));
    expect(getByTestId('amount').props.value).toBe('700');
  });

  it('syncs the text when the parent resets the value', async () => {
    const { getByTestId, rerender } = await renderWithProviders(
      <AmountInput label="Amount" valueCents={12300} onChangeCents={() => {}} testID="amount" />,
    );
    expect(getByTestId('amount').props.value).toBe('123');
    await rerender(
      <AmountInput label="Amount" valueCents={0} onChangeCents={() => {}} testID="amount" />,
    );
    expect(getByTestId('amount').props.value).toBe('');
  });
});
