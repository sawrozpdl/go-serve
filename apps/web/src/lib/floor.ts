// Bucketing the open orders behind the Floor screen.
//
// FloorPage used to split them on `service_table_id` alone: anything without a
// table fell into "walk-ins". A staff meal has no table BY CONSTRUCTION —
// migration 0076 added a CHECK forbidding it one, because the whole point of
// the feature is that feeding the team must not occupy a seat the cafe wanted
// to sell. So every open staff meal landed in the walk-in grid and rendered
// through `resolveTableLabel(o, 'Walk-in')` as an ordinary paying guest, with
// the person's name already sitting unused on the row.
//
// The consequence is worse than cosmetic: a staff meal never becomes a sale, so
// a tile that looks like a walk-in is a tile whose money will never arrive, and
// nothing on the floor said so.

import type { Order } from '@/lib/api';

export type FloorBuckets = {
  /** Open order per service_table_id, for the table grid. */
  byTable: Map<string, Order>;
  /** Table-less serves: takeaway and named walk-ins. */
  walkins: Order[];
  /** Table-less serves attributed to a staff member. Never a sale. */
  staffMeals: Order[];
};

export function bucketOpenOrders(orders: readonly Order[]): FloorBuckets {
  const byTable = new Map<string, Order>();
  const walkins: Order[] = [];
  const staffMeals: Order[] = [];

  for (const o of orders) {
    // A table always wins. The DB forbids a staff meal from holding one, but
    // this function is also handed optimistic/offline rows that have not been
    // through the constraint yet, and a tile that disappears from the table
    // grid is a table the floor thinks is free.
    if (o.service_table_id) {
      byTable.set(o.service_table_id, o);
      continue;
    }
    if (o.staff_id) {
      staffMeals.push(o);
      continue;
    }
    walkins.push(o);
  }

  return { byTable, walkins, staffMeals };
}
