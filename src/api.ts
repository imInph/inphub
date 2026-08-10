/**
 * inphub — typed fetch wrapper around the PHP JSON API.
 *
 * Every endpoint answers with the envelope { ok: true, data } or
 * { ok: false, error }. request() unwraps it and throws on failure so callers
 * can use plain try/catch. The API lives one directory up from /public.
 */

const API_BASE = '../api/';

export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Low-level request. Endpoint is the file name without ".php". */
async function request<T = any>(
  endpoint: string,
  action: string,
  init: RequestInit = {},
  query: Record<string, string | number | undefined> = {},
): Promise<T> {
  const params = new URLSearchParams();
  if (action) params.set('action', action);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const url = `${API_BASE}${endpoint}.php?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch (e) {
    // Deliberate cancellations (AbortController) must stay distinguishable.
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('Network error — is the server running?', 0);
  }

  // 401 → session expired; bounce to login.
  if (res.status === 401) {
    window.location.href = 'login.php';
    throw new ApiError('Not authenticated.', 401);
  }

  let body: Envelope<T>;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`Bad response (HTTP ${res.status}).`, res.status);
  }

  if (!body.ok) {
    throw new ApiError(body.error || `Request failed (HTTP ${res.status}).`, res.status);
  }
  return body.data as T;
}

/** GET a read action. */
export function apiGet<T = any>(
  endpoint: string,
  action = 'list',
  query: Record<string, string | number | undefined> = {},
): Promise<T> {
  return request<T>(endpoint, action, { method: 'GET' }, query);
}

/** POST a mutation action with a JSON body. */
export function apiPost<T = any>(
  endpoint: string,
  action: string,
  payload: Record<string, unknown> = {},
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  return request<T>(endpoint, action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
}
