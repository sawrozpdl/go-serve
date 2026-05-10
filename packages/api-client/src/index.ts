/**
 * Hand-written client surface for now. Will be augmented with OpenAPI-generated
 * types in M1+ once the contract stabilises.
 */

export type ApiError = { status: number; message: string; code?: string };

export type ApiClientOptions = {
  baseUrl?: string;
  /** Subdomain or slug; sent as X-Tenant-ID when subdomain isn't natural. */
  tenantId?: string;
  /** Additional headers (Authorization, etc). */
  headers?: Record<string, string>;
  /** Override fetch (test injection). */
  fetcher?: typeof fetch;
};

export class ApiClient {
  private baseUrl: string;
  private tenantId?: string;
  private headers: Record<string, string>;
  private fetcher: typeof fetch;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? '';
    this.tenantId = opts.tenantId;
    this.headers = opts.headers ?? {};
    this.fetcher = opts.fetcher ?? fetch.bind(globalThis);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.headers,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.tenantId) headers['X-Tenant-ID'] = this.tenantId;

    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let message = res.statusText;
      try {
        const j = (await res.json()) as { message?: string; code?: string };
        if (j.message) message = j.message;
        const err: ApiError = { status: res.status, message, code: j.code };
        throw err;
      } catch {
        const err: ApiError = { status: res.status, message };
        throw err;
      }
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body);
  }
  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
}
