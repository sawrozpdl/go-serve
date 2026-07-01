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
});
