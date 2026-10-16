export function resolveToken(requiredScopes: string[]): { token: string; expiresAt: number; scopes: string[] } | null {
  let clientHint: string | null = null;
  const authCookies = (document.cookie || '').split('; ').filter(v => /^auth0\.[^.]+\.is\.authenticated=/.test(v));
  if (authCookies.length === 1) clientHint = authCookies[0].split('.')[1];
  const candidates: { token: string; expiresAt: number; scopes: string[] }[] = [];
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
  for (const key of keys) {
    if (!key?.startsWith('@@auth0spajs@@') || !key.includes('::https://api.bigw.com.au/api::') || key.endsWith('@@user@@')) continue;
    try {
      const cached = JSON.parse(localStorage.getItem(key) ?? 'null');
      const client = key.split('::')[1];
      if (!cached?.body?.access_token || (clientHint && client !== clientHint)) continue;
      if (cached.body.client_id && cached.body.client_id !== client) continue;
      const scopes = String(cached.body.scope || key.split('::').slice(3).join('::')).split(/\s+/);
      if (!(requiredScopes || []).every(scope => scopes.includes(scope))) continue;
      candidates.push({ token: cached.body.access_token, expiresAt: Number(cached.expiresAt) || 0, scopes });
    } catch { /* skip malformed cache entries */ }
  }
  candidates.sort((a, b) => b.expiresAt - a.expiresAt || b.scopes.length - a.scopes.length);
  return candidates[0] ?? null;
}

export function scopesForPath(path: string, method?: string): string[] {
  if (path.startsWith('/profile/')) return ['account:view', 'account:pii:view'];
  if (path.includes('/saved-cards') || path.includes('/payment-options')) return ['payment:view'];
  if (/\/pay(?:\/|$)/.test(path)) return ['payment:manage', 'payment:authorise'];
  return method === 'POST' ? ['cart:manage'] : ['cart:view'];
}

export interface BridgeArgs { origin: string; path: string; method?: string; body?: unknown; publicRequest?: boolean; token?: string; timeoutMs?: number }

export type BridgeResult = { ok: boolean; status: number; data?: unknown; code?: string };

export async function pageRequest(args: BridgeArgs): Promise<BridgeResult> {
  if (!['https://api.bigw.com.au', 'https://apix.bigw.com.au'].includes(args.origin) || !args.path.startsWith('/') || args.path.startsWith('//')) return { ok: false, status: 0, code: 'REQUEST_ORIGIN' };
  const headers: Record<string, string> = { accept: 'application/json' };
  if (args.body !== undefined) headers['content-type'] = 'application/json';
  if (!args.publicRequest) {
    if (!args.token) return { ok: false, status: 401, code: 'LOGIN_REQUIRED' };
    headers[args.path.startsWith('/profile/') ? 'authorization' : 'authorization3'] = `Bearer ${args.token}`;
  }
  try {
    const response = await fetch(args.origin + args.path, {
      method: args.method || 'GET', credentials: args.origin.includes('apix.') ? 'omit' : 'include',
      headers, body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: AbortSignal.timeout(args.timeoutMs || 20000),
    });
    if (!response.ok) return { ok: false, status: response.status, code: response.status === 401 ? 'LOGIN_REQUIRED' : response.status === 403 ? 'BROWSER_ATTENTION' : 'STORE_REQUEST' };
    if (response.status === 204) return { ok: true, status: 204, data: null };
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, code: (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'REQUEST_NETWORK' };
  }
}

const CHANNEL = 'duke';

export async function handleMessage(message: { channel: string; requestId: string; kind?: string; args: BridgeArgs & { scopes?: string[] } }, post: (msg: unknown) => void): Promise<void> {
  if (message?.channel !== CHANNEL || typeof message.requestId !== 'string' || typeof message.args !== 'object' || message.args === null) return;
  const scopes = message.args.publicRequest ? [] : (message.args.scopes ?? ['cart:view']);
  const token = message.args.publicRequest ? undefined : resolveToken(scopes)?.token;
  const result = await pageRequest({ ...message.args, token });
  post({ channel: CHANNEL, requestId: message.requestId, result });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    void handleMessage(event.data, msg => window.postMessage(msg, '*'));
  });
}
