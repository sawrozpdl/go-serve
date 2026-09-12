/**
 * The order screens' one add-on picker, wired to the controller.
 *
 * It serves two jobs that look the same to the waiter and are different
 * underneath: picking extras while ADDING a dish from the grid, and CHANGING
 * the extras on a line that is already on the ticket. `ctrl.addOnLine` is what
 * separates them — set, and confirming replaces that line's whole add-on set;
 * null, and confirming adds a new line.
 *
 * Mounted by both the phone's menu screen and the tablet split view, because
 * whichever composition took the tap has to be able to show the sheet. Sharing
 * this component is what keeps the two from drifting.
 */
import { AddOnSheet } from '@/components/order/AddOnSheet';
import type { OrderController } from '@/components/order/useOrderController';

export function OrderAddOnSheet({ ctrl }: { ctrl: OrderController }) {
  const close = () => {
    ctrl.setAddOnFor(null);
    ctrl.setAddOnLine(null);
  };
  return (
    <AddOnSheet
      item={ctrl.addOnFor}
      category={ctrl.addOnCategory}
      groups={ctrl.modifierGroups}
      loading={ctrl.modifierGroupsLoading}
      initial={ctrl.addOnLine?.add_ons}
      mode={ctrl.addOnLine ? 'edit' : 'add'}
      onClose={close}
      onConfirm={(addOns) => {
        const mi = ctrl.addOnFor;
        const line = ctrl.addOnLine;
        close();
        if (line) ctrl.setLineAddOns(line, addOns);
        else if (mi) void ctrl.addMenuItem(mi, addOns);
      }}
    />
  );
}
