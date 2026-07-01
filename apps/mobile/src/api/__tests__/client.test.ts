import * as SecureStore from 'expo-secure-store';
import { request, api, setAuthHandlers } from '../client';
import { setTokens, clearTokens, getAccessToken } from '../../auth/tokenStore';
import { useConnectivity } from '../../stores/connectivity';

const reset = (SecureStore as unknown as { __reset: () => void }).__reset;

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    headers: new Map(Object.entries(headers)),
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: jest.SpyInstance;

beforeEach(async () => {
  reset();
  await clearTokens();
  useConnectivity.setState({ mode: 'online' });
  setAuthHandlers({ onUnauthenticated: () => {} });
  fetchMock = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchMock.mockRestore();
});

describe('request', () => {
  it('sends the bearer token and tenant header, returns JSON', async () => {
    await setTokens('access-1', 'refresh-1');
    fetchMock.mockResolvedValueOnce(res(200, { ok: true }));
    const out = await request<{ ok: boolean }>('GET', '/v1/thing', { tenantSlug: 'sahan' });
    expect(out).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer access-1',
      'X-Tenant-ID': 'sahan',
    });
  });

  it('refreshes once on 401 and retries the original request', async () => {
    await setTokens('stale-access', 'refresh-1');
    fetchMock
      .mockResolvedValueOnce(res(401, {})) // original 401
      .mockResolvedValueOnce(
        res(200, {
          access_token: 'fresh-access',
          refresh_token: 'refresh-2',
          access_expires_in: 900,
          user_id: 'u',
          session_id: 's',
        }),
      ) // /auth/refresh
      .mockResolvedValueOnce(res(200, { data: 42 })); // retry
    const out = await request<{ data: number }>('GET', '/v1/thing');
    expect(out).toEqual({ data: 42 });
    expect(getAccessToken()).toBe('fresh-access');
    // retry carried the new token
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer fresh-access');
  });

  it('signs out when the refresh token is rejected', async () => {
    await setTokens('stale-access', 'refresh-1');
    const onUnauthenticated = jest.fn();
    setAuthHandlers({ onUnauthenticated });
    fetchMock
      .mockResolvedValueOnce(res(401, {})) // original 401
      .mockResolvedValueOnce(res(401, {})); // refresh rejected
    await expect(request('GET', '/v1/thing')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthenticated).toHaveBeenCalled();
  });

  it('does not attempt refresh for /auth/* paths', async () => {
    fetchMock.mockResolvedValueOnce(res(401, { code: 'otp_invalid', message: 'bad code' }));
    await expect(api.post('/auth/verify-otp', { email: 'x', code: '000000' })).rejects.toMatchObject({
      status: 401,
      code: 'otp_invalid',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses structured error fields (retry_after_seconds, attempts_remaining)', async () => {
    fetchMock.mockResolvedValueOnce(
      res(429, { message: 'slow down', code: 'rate_limited', retry_after_seconds: 30 }),
    );
    await expect(api.post('/auth/request-otp', { email: 'x' })).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retry_after_seconds: 30,
    });
  });

  it('throws a status-0 offline error and marks offline when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(request('GET', '/v1/thing')).rejects.toMatchObject({ status: 0, code: 'network' });
    expect(useConnectivity.getState().mode).toBe('offline');
  });

  it('gives a clear error when the response is not JSON (wrong API URL)', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected character: <');
      },
    } as unknown as Response);
    await expect(request('GET', '/auth/config')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('returns undefined for 204 No Content', async () => {
    fetchMock.mockResolvedValueOnce(res(204, null));
    await expect(api.del('/v1/thing/1')).resolves.toBeUndefined();
  });

  it('marks online again after a successful request', async () => {
    useConnectivity.setState({ mode: 'offline' });
    fetchMock.mockResolvedValueOnce(res(200, {}));
    await request('GET', '/v1/thing');
    expect(useConnectivity.getState().mode).toBe('online');
  });
});
