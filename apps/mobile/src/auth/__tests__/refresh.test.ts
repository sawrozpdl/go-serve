import { createRefresher, type RefreshDeps } from '../refresh';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function makeDeps(over: Partial<RefreshDeps> = {}): RefreshDeps & {
  setTokens: jest.Mock;
  fetchFn: jest.Mock;
} {
  const setTokens = jest.fn();
  const fetchFn = jest.fn();
  return {
    apiBase: 'https://api.test',
    getRefreshToken: () => 'rt-1',
    setTokens,
    fetchFn,
    ...over,
  } as RefreshDeps & { setTokens: jest.Mock; fetchFn: jest.Mock };
}

describe('createRefresher', () => {
  it('returns invalid immediately when there is no refresh token', async () => {
    const deps = makeDeps({ getRefreshToken: () => null });
    const refresh = createRefresher(deps);
    expect(await refresh()).toBe('invalid');
    expect(deps.fetchFn).not.toHaveBeenCalled();
  });

  it('rotates tokens and returns ok on success', async () => {
    const deps = makeDeps();
    deps.fetchFn.mockResolvedValue(
      jsonResponse(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        access_expires_in: 900,
        user_id: 'u1',
        session_id: 's1',
      }),
    );
    const refresh = createRefresher(deps);
    expect(await refresh()).toBe('ok');
    expect(deps.setTokens).toHaveBeenCalledWith('new-access', 'new-refresh');
    expect(deps.fetchFn).toHaveBeenCalledWith(
      'https://api.test/auth/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns invalid on 401 (revoked/reuse) without touching tokens', async () => {
    const deps = makeDeps();
    deps.fetchFn.mockResolvedValue(jsonResponse(401, {}));
    expect(await createRefresher(deps)()).toBe('invalid');
    expect(deps.setTokens).not.toHaveBeenCalled();
  });

  it('returns invalid on 403', async () => {
    const deps = makeDeps();
    deps.fetchFn.mockResolvedValue(jsonResponse(403, {}));
    expect(await createRefresher(deps)()).toBe('invalid');
  });

  it('returns network on a 5xx (session may still be valid)', async () => {
    const deps = makeDeps();
    deps.fetchFn.mockResolvedValue(jsonResponse(503, {}));
    expect(await createRefresher(deps)()).toBe('network');
    expect(deps.setTokens).not.toHaveBeenCalled();
  });

  it('returns network and signals offline when fetch throws', async () => {
    const onNetworkError = jest.fn();
    const deps = makeDeps({ onNetworkError });
    deps.fetchFn.mockRejectedValue(new Error('offline'));
    expect(await createRefresher(deps)()).toBe('network');
    expect(onNetworkError).toHaveBeenCalled();
  });

  it('is single-flight: concurrent calls share one fetch', async () => {
    const deps = makeDeps();
    let resolveFetch!: (r: Response) => void;
    deps.fetchFn.mockReturnValue(new Promise<Response>((r) => (resolveFetch = r)));
    const refresh = createRefresher(deps);
    const a = refresh();
    const b = refresh();
    resolveFetch(
      jsonResponse(200, {
        access_token: 'a',
        refresh_token: 'r',
        access_expires_in: 900,
        user_id: 'u',
        session_id: 's',
      }),
    );
    await Promise.all([a, b]);
    expect(deps.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('allows a new fetch after the in-flight one settles', async () => {
    const deps = makeDeps();
    deps.fetchFn.mockResolvedValue(
      jsonResponse(200, {
        access_token: 'a',
        refresh_token: 'r',
        access_expires_in: 900,
        user_id: 'u',
        session_id: 's',
      }),
    );
    const refresh = createRefresher(deps);
    await refresh();
    await refresh();
    expect(deps.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('defaults to global fetch when no fetchFn is injected', () => {
    // Just constructs without throwing; exercising the `?? fetch` branch.
    const refresh = createRefresher({
      apiBase: 'https://api.test',
      getRefreshToken: () => null,
      setTokens: jest.fn(),
    });
    expect(typeof refresh).toBe('function');
  });
});

// A failed Keystore write used to come back as 'network': the app marked itself
// offline over a storage fault, and the one fact worth surfacing — that the
// session will not survive a restart — was lost. The rotation itself succeeded,
// so the session is good for this run and must be reported as such.
describe('a storage failure is not a network failure', () => {
  const okResponse = () =>
    new Response(JSON.stringify({ access_token: 'new-a', refresh_token: 'new-r' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('reports ok, flags the persist failure, and does not mark the app offline', async () => {
    const onNetworkError = jest.fn();
    const onPersistError = jest.fn();
    const refresh = createRefresher({
      apiBase: 'https://api.test',
      getRefreshToken: () => 'stored-r',
      setTokens: async () => {
        throw new Error('could not encrypt the value');
      },
      fetchFn: (async () => okResponse()) as unknown as typeof fetch,
      onNetworkError,
      onPersistError,
    });

    await expect(refresh()).resolves.toBe('ok');
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(onNetworkError).not.toHaveBeenCalled();
  });

  it('still reports network when the request itself fails', async () => {
    const onNetworkError = jest.fn();
    const onPersistError = jest.fn();
    const refresh = createRefresher({
      apiBase: 'https://api.test',
      getRefreshToken: () => 'stored-r',
      setTokens: jest.fn(),
      fetchFn: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
      onNetworkError,
      onPersistError,
    });

    await expect(refresh()).resolves.toBe('network');
    expect(onNetworkError).toHaveBeenCalledTimes(1);
    expect(onPersistError).not.toHaveBeenCalled();
  });
});
