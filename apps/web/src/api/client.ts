/**
 * API 客户端（API_CONTRACT）：Bearer token 存 sessionStorage（仅当前 tab），
 * 响应信封 { data, meta } / { error }；领域错误以 ApiError 抛出。
 */

const TOKEN_KEY = 'treediagram.admin-token';

export function loadToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string;

  constructor(status: number, body: unknown) {
    const err =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error: Record<string, unknown> }).error
        : {};
    super(typeof err['message'] === 'string' ? err['message'] : `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof err['code'] === 'string' ? err['code'] : 'UNKNOWN';
    this.details = (err['details'] as Record<string, unknown>) ?? {};
    this.requestId = typeof err['requestId'] === 'string' ? err['requestId'] : '';
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
}

export function createApiClient(token: string): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as T;
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json);
    const data = (json as { data?: unknown } | null)?.data;
    return data as T;
  }
  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    del: (path: string) => request<void>('DELETE', path),
  };
}
