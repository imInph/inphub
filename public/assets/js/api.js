/**
 * inphub — typed fetch wrapper around the PHP JSON API.
 *
 * Every endpoint answers with the envelope { ok: true, data } or
 * { ok: false, error }. request() unwraps it and throws on failure so callers
 * can use plain try/catch. The API lives one directory up from /public.
 */
const API_BASE = '../api/';
export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
/** Low-level request. Endpoint is the file name without ".php". */
async function request(endpoint, action, init = {}, query = {}) {
    const params = new URLSearchParams();
    if (action)
        params.set('action', action);
    for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '')
            params.set(k, String(v));
    }
    const url = `${API_BASE}${endpoint}.php?${params.toString()}`;
    let res;
    try {
        res = await fetch(url, { credentials: 'same-origin', ...init });
    }
    catch {
        throw new ApiError('Network error — is the server running?', 0);
    }
    // 401 → session expired; bounce to login.
    if (res.status === 401) {
        window.location.href = 'login.php';
        throw new ApiError('Not authenticated.', 401);
    }
    let body;
    try {
        body = await res.json();
    }
    catch {
        throw new ApiError(`Bad response (HTTP ${res.status}).`, res.status);
    }
    if (!body.ok) {
        throw new ApiError(body.error || `Request failed (HTTP ${res.status}).`, res.status);
    }
    return body.data;
}
/** GET a read action. */
export function apiGet(endpoint, action = 'list', query = {}) {
    return request(endpoint, action, { method: 'GET' }, query);
}
/** POST a mutation action with a JSON body. */
export function apiPost(endpoint, action, payload = {}) {
    return request(endpoint, action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}
