/**
 * LAN thermal-printer discovery (M6). We can't enumerate the device's own IP
 * without a native module (expo-network → dev-client rebuild), so discovery is
 * seeded from a known /24 base: either an already-configured printer IP or a
 * base the user types (e.g. "192.168.1"). We then probe every host on that /24
 * at the JetDirect port (9100) with bounded concurrency and collect the ones
 * that accept a connection.
 *
 * The IP math + the concurrency pool are pure and unit-tested; the actual TCP
 * probe (probePrinter) is the only native/untested piece.
 */
import { probePrinter } from './tcpPrinter';

/** First three octets of an IPv4, or null if it isn't a dotted quad.
 * `deriveScanBase('192.168.1.50') === '192.168.1'`. */
export function deriveScanBase(ip: string): string | null {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((n) => n > 255)) return null;
  return octets.slice(0, 3).join('.');
}

/** Accept a full IP ("192.168.1.50") or a bare base ("192.168.1") and return the
 * normalized "/24" base, or null if neither. */
export function normalizeBase(input: string): string | null {
  const s = input.trim().replace(/\.$/, '');
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) {
    return s.split('.').every((o) => Number(o) <= 255) ? s : null;
  }
  return deriveScanBase(s);
}

/** All host IPs on a /24 (`.1`–`.254`; skips network .0 and broadcast .255). */
export function candidateHosts(base: string): string[] {
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) hosts.push(`${base}.${i}`);
  return hosts;
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving the
 * input order in the results. Pure aside from the injected `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const pool = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(pool);
  return results;
}

export type ScanOptions = {
  port?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** Called as each reachable printer is found, for live UI updates. */
  onFound?: (ip: string) => void;
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
};

/** Probe every host on the base /24 and return the IPs that answered on `port`. */
export async function scanForPrinters(base: string, opts: ScanOptions = {}): Promise<string[]> {
  const port = opts.port ?? 9100;
  const timeoutMs = opts.timeoutMs ?? 1200;
  const probe = opts.probe ?? probePrinter;
  const found: string[] = [];
  await mapWithConcurrency(candidateHosts(base), opts.concurrency ?? 24, async (host) => {
    const ok = await probe(host, port, timeoutMs);
    if (ok) {
      found.push(host);
      opts.onFound?.(host);
    }
    return ok;
  });
  return found;
}
