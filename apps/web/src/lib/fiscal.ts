// IRD fiscal helpers shared by the settle and print flows.
import { normalizePAN, type FiscalBuyer } from '@cafe-mgmt/api-types';

/** True when the buyer block may be sent (empty, or a valid PAN). */
export function buyerValid(b: FiscalBuyer): boolean {
  return !b.pan || !!normalizePAN(b.pan);
}

/** Drops empty fields so a walk-in settle sends no buyer at all. */
export function cleanBuyer(b: FiscalBuyer): FiscalBuyer | undefined {
  const out: FiscalBuyer = {};
  if (b.name?.trim()) out.name = b.name.trim();
  if (b.pan?.trim()) out.pan = normalizePAN(b.pan) ?? b.pan.trim();
  if (b.address?.trim()) out.address = b.address.trim();
  return Object.keys(out).length ? out : undefined;
}
