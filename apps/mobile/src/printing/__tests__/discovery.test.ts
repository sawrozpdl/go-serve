import {
  deriveScanBase,
  normalizeBase,
  candidateHosts,
  mapWithConcurrency,
  scanForPrinters,
} from '../discovery';

describe('deriveScanBase', () => {
  it('returns the first three octets of a valid IPv4', () => {
    expect(deriveScanBase('192.168.1.50')).toBe('192.168.1');
    expect(deriveScanBase('10.0.0.255')).toBe('10.0.0');
  });
  it('rejects non-quads and out-of-range octets', () => {
    expect(deriveScanBase('192.168.1')).toBeNull();
    expect(deriveScanBase('999.1.1.1')).toBeNull();
    expect(deriveScanBase('not-an-ip')).toBeNull();
  });
});

describe('normalizeBase', () => {
  it('accepts a full IP, a bare base, and a trailing dot', () => {
    expect(normalizeBase('192.168.1.50')).toBe('192.168.1');
    expect(normalizeBase('192.168.1')).toBe('192.168.1');
    expect(normalizeBase('192.168.1.')).toBe('192.168.1');
  });
  it('rejects garbage and out-of-range bases', () => {
    expect(normalizeBase('192.168')).toBeNull();
    expect(normalizeBase('192.300.1')).toBeNull();
    expect(normalizeBase('')).toBeNull();
  });
});

describe('candidateHosts', () => {
  it('enumerates .1–.254 (skips network + broadcast)', () => {
    const hosts = candidateHosts('192.168.1');
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts[253]).toBe('192.168.1.254');
    expect(hosts).not.toContain('192.168.1.0');
    expect(hosts).not.toContain('192.168.1.255');
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and returns all results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });

  it('stops picking up new items once shouldStop flips true', async () => {
    let calls = 0;
    let stop = false;
    await mapWithConcurrency(
      Array.from({ length: 100 }, (_, i) => i),
      1,
      async () => {
        calls++;
        if (calls === 5) stop = true;
      },
      () => stop,
    );
    expect(calls).toBe(5);
  });
});

describe('scanForPrinters', () => {
  it('collects only hosts that answer, and reports them via onFound', async () => {
    const answering = new Set(['192.168.1.50', '192.168.1.77']);
    const found: string[] = [];
    const result = await scanForPrinters('192.168.1', {
      concurrency: 8,
      probe: async (host) => answering.has(host),
      onFound: (ip) => found.push(ip),
    });
    expect(result.sort()).toEqual(['192.168.1.50', '192.168.1.77']);
    expect(found.sort()).toEqual(['192.168.1.50', '192.168.1.77']);
  });

  it('passes the configured port + timeout to the probe', async () => {
    const seen: [string, number, number][] = [];
    await scanForPrinters('10.0.0', {
      port: 9101,
      timeoutMs: 500,
      concurrency: 254,
      probe: async (host, port, t) => {
        seen.push([host, port, t]);
        return false;
      },
    });
    expect(seen).toHaveLength(254);
    expect(seen[0]).toEqual(['10.0.0.1', 9101, 500]);
  });

  it('probes priorityHost first, ahead of the in-order sweep', async () => {
    const order: string[] = [];
    await scanForPrinters('192.168.1', {
      concurrency: 1,
      priorityHost: '192.168.1.77',
      probe: async (host) => {
        order.push(host);
        return false;
      },
    });
    expect(order[0]).toBe('192.168.1.77');
    expect(order).toHaveLength(254);
  });

  it('stops issuing probes when the signal is cancelled, keeping earlier finds', async () => {
    const signal = { cancelled: false };
    const probed: string[] = [];
    const result = await scanForPrinters('192.168.1', {
      concurrency: 1,
      signal,
      probe: async (host) => {
        probed.push(host);
        if (host === '192.168.1.3') {
          signal.cancelled = true;
          return true;
        }
        return false;
      },
    });
    expect(result).toEqual(['192.168.1.3']);
    expect(probed).toHaveLength(3);
  });
});
