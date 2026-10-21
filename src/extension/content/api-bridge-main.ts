// MAIN-world bridge for bigw.com.au pages, adapted from the server original
// (src/server/browser/page-api.ts request()). Three deliberate deviations:
// (a) the token is resolved here via resolveToken(); any caller-supplied token
//     is ignored so credentials never cross worlds;
// (b) the server's SESSION_EXPIRED pre-check (expiresAt < now + 15s) is
//     dropped — expired tokens simply get rejected by BIG W as 401, which
//     maps to LOGIN_REQUIRED;
// (c) localStorage is enumerated via key(i)/length (works identically under
//     the injected-world sandbox and in tests without DOM stubs).
//
// It also hosts the MAIN-world payment guard and observer (Stage 2). The guard
// wraps window.fetch once, always present, but only makes decisions while a
// binding is enabled. It mirrors the server PaymentGuard.handle decision core
// (shared/payment-check.ts). XHR is patched best-effort as well: the BIG W
// checkout and this bridge both use fetch, so XHR is a secondary net. A
// blocked request never reaches the network; fetch rejects with a TypeError
// (mirroring a blocked interception) and XHR surfaces error/readystatechange
// with status 0.
//
// ---------------------------------------------------------------------------
// TRUST BOUNDARY (read before relying on this guard)
// ---------------------------------------------------------------------------
// This guard is NOT a security boundary against the page. It runs in the
// MAIN world, so any script on bigw.com.au can reassign window.fetch after
// install, post fabricated `guard.event` messages, or drive the control
// surface (window.postMessage `control`) directly. It exists only to constrain
// the automated checkout flow's own accidental or drifted submissions — a
// safety interlock for our driver, not a wall against the page.
//
// Consequence for consumers: the service worker MUST treat `guard.event` as
// ADVISORY, never authoritative. Reconcile every sent/prevented/uncertain
// event against `observe.list` and/or the run's own request results before
// making a financial decision. A `prevented` event does not prove nothing was
// charged, and the absence of one does not prove a charge was made.
//
// Guarding limitations (fail-closed unless stated otherwise):
//   - Relative-URL requests are UNGUARDED: financialUrl() requires an absolute
//     URL, so a same-origin-relative `fetch('/storefront/v1/cart/.../pay')`
//     never matches and is forwarded untouched. The automated driver always
//     issues absolute URLs; a page script using relative URLs bypasses the
//     guard entirely (see the trust boundary note above — it is not a wall).
//   - Non-string bodies (FormData/Blob/ArrayBuffer/URLSearchParams) are
//     unreadable to checkPaymentRequest and are therefore treated as
//     PAYMENT_CHANGED (blocked) while a binding is enabled.
//   - fetch(Request) bodies are read from a clone so the real body reaches
//     checkPaymentRequest; the original Request is left intact for forwarding.
import { checkPaymentRequest, financialUrl, type PaymentBinding } from '../../shared/payment-check.ts';

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

// Direct port of PAGE_CONTEXT (src/server/browser/page-api.ts). Same reads and
// decode-in-try/catch semantics; resolveToken() is this file's own version.
export function pageContext(): {
  authenticated: boolean;
  tokenSecondsRemaining: number;
  cartId: string | null;
  storeId: unknown;
  delivery: unknown;
} {
  const cached = resolveToken(['cart:view']);
  let cartId: unknown = null;
  try { cartId = JSON.parse(localStorage.getItem('bigw:state-cartId') ?? 'null'); } catch { /* fall through with the default */ }
  const cookie = (name: string): unknown => {
    const value = (document.cookie || '').split('; ').find(part => part.startsWith(`${name}=`));
    if (!value) return null;
    const raw = decodeURIComponent(value.slice(name.length + 1));
    // Store/location cookies are usually JSON, but a plain store id is valid
    // too (and some builds write one). A value that looks like JSON but does
    // not parse is corrupt, so discard it instead of using half an object.
    try { return JSON.parse(raw); } catch { return /^[{\[]/.test(raw.trim()) ? null : raw; }
  };
  return {
    authenticated: !!cached?.token,
    tokenSecondsRemaining: cached?.expiresAt ? Math.floor(cached.expiresAt - Date.now() / 1000) : 0,
    cartId: typeof cartId === 'string' ? cartId : null,
    storeId: cookie('bigw_location-store'),
    delivery: cookie('bigw_location-delivery'),
  };
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

// ---------------------------------------------------------------------------
// MAIN-world payment guard + observer
// ---------------------------------------------------------------------------

// status === -1 means the request was sent and its response is still pending;
// any status >= 0 is a settled response (0 = the request failed at the network).
export interface ObservedEntry { url: string; method: string; status: number; bodyText: string }

interface GuardState { binding: PaymentBinding | null; sent: boolean; finalized: boolean }

const guardState: GuardState = { binding: null, sent: false, finalized: false };
const observeEntries: ObservedEntry[] = [];
const OBSERVE_LIMIT = 20;
const OBSERVE_BODY_LIMIT = 32_768;

// Test-only fault injection. Off in production; flipped through `__test`.
const testHooks = { forceDecisionError: false };

type GuardEvent = { type: 'sent' | 'prevented' | 'uncertain'; code?: string };

function notifyGuard(event: GuardEvent): void {
  if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
    window.postMessage({ channel: CHANNEL, kind: 'guard.event', event }, '*');
  }
}

// Duplicated from src/server/browser/payment.ts (isPaymentEndpoint with an
// unknown cart id / isVaultEndpoint verbatim). The extension bundle must not
// import the puppeteer-backed server module, so the tiny predicates live here.
function isPaymentEndpoint(url: string): boolean {
  try {
    const value = new URL(url);
    return value.origin === 'https://api.bigw.com.au' && /^\/storefront\/v1\/cart\/[^/]+\/pay(?:\/finalize)?$/.test(decodeURIComponent(value.pathname));
  } catch { return false; }
}

function isVaultEndpoint(url: string): boolean {
  try {
    const value = new URL(url);
    return value.origin === 'https://api.wpay2.gr4vy.app' && /^\/checkout\/sessions\/[^/]+\/card-details$/.test(value.pathname);
  } catch { return false; }
}

// Record a request as sent the moment it is forwarded (status -1 = in flight)
// and return the entry so the response can update it in place. This is the
// MAIN-world analogue of PaymentGuard.onSent: a consumer that sees an entry for
// a payment endpoint knows the request actually left, before any response.
function recordSent(url: string, method: string): ObservedEntry {
  const entry: ObservedEntry = { url, method, status: -1, bodyText: '' };
  observeEntries.push(entry);
  while (observeEntries.length > OBSERVE_LIMIT) observeEntries.shift();
  return entry;
}

// Fill in the real response on the entry created by recordSent(). If the entry
// was evicted from the bounded buffer while the response was in flight, drop the
// update rather than resurrecting a stale request.
function updateObserved(entry: ObservedEntry, status: number, bodyText: string): void {
  if (!observeEntries.includes(entry)) return;
  entry.status = status;
  entry.bodyText = bodyText.slice(0, OBSERVE_BODY_LIMIT);
}

// Same decision core as PaymentGuard.handle, minus the page/request plumbing.
// Mutates sent/finalized only when the request is allowed.
function decideFinancial(url: string, body: string | undefined): { prevent: string } | { allow: true } {
  if (testHooks.forceDecisionError) throw new Error('forced decision error');
  const binding = guardState.binding as PaymentBinding;
  const finalizer = new URL(url).pathname.endsWith('/finalize');
  const duplicate = finalizer ? !guardState.sent || guardState.finalized : guardState.sent;
  const violation = checkPaymentRequest(url, body, binding);
  if (duplicate || violation) return { prevent: violation ?? 'PAYMENT_DUPLICATE' };
  if (finalizer) guardState.finalized = true;
  else { guardState.sent = true; notifyGuard({ type: 'sent' }); }
  return { allow: true };
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string; body?: string } {
  const method = String(init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET') ?? 'GET').toUpperCase();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = typeof init?.body === 'string' ? init.body : undefined;
  return { url, method, body };
}

type WrappedFetch = typeof fetch & { __dukeGuard?: true; __dukeOriginal?: typeof fetch };

function installFetchGuard(): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const current = window.fetch as WrappedFetch;
  if (current.__dukeGuard) return;
  const original = window.fetch.bind(window);
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Describing the request and reaching a decision runs on EVERY fetch, so
    // it is fenced: an unexpected input shape (or any bug in our own logic)
    // must never break the retailer's own fetch. On error we fail open,
    // forward to the original fetch, and report `uncertain` for reconciliation.
    let described: { url: string; method: string; body?: string } | null = null;
    try {
      described = describeRequest(input, init);
      const enabled = guardState.binding !== null;
      const financial = described.method === 'POST' && !!financialUrl(described.url);
      if (enabled && financial) {
        // A fetch(Request) carries its body on the Request, not in init. Read a
        // clone (async, still inside the fence) so the original Request's body
        // stays intact for forwarding and checkPaymentRequest sees real JSON.
        if (typeof Request !== 'undefined' && input instanceof Request) {
          described.body = await input.clone().text();
        }
        const decision = decideFinancial(described.url, described.body);
        if ('prevent' in decision) {
          notifyGuard({ type: 'prevented', code: decision.prevent });
          return Promise.reject(new TypeError('Failed to fetch'));
        }
      }
    } catch {
      // Fail-open: only a positive decision above prevents forwarding; every
      // other error reports `uncertain` and falls through to the original.
      notifyGuard({ type: 'uncertain' });
    }
    const url = described?.url ?? '';
    const method = described?.method ?? 'GET';
    const observed = described !== null && method === 'POST' && (isPaymentEndpoint(url) || isVaultEndpoint(url));
    // Record the sent request BEFORE forwarding so a consumer polling the
    // observer sees the in-flight entry immediately (PaymentGuard.onSent). The
    // same entry is updated in place once the response settles or fails.
    const entry = observed ? recordSent(url, method) : null;
    try {
      const response = await original(input, init);
      if (entry) {
        // Do not await the body before returning: a streamed or never-ending
        // response must not hang the caller. Observe a clone asynchronously.
        const clone = response.clone();
        void clone.text()
          .then(text => updateObserved(entry, response.status, text))
          .catch(() => updateObserved(entry, response.status, ''));
      }
      return response;
    } catch (error) {
      if (entry) updateObserved(entry, 0, '');
      // A guarded financial request that never got an answer is uncertain: the
      // outcome cannot be confirmed, so the SW must reconcile it.
      if (described !== null && method === 'POST' && guardState.binding !== null && !!financialUrl(url)) notifyGuard({ type: 'uncertain' });
      throw error;
    }
  };
  (guarded as WrappedFetch).__dukeGuard = true;
  (guarded as WrappedFetch).__dukeOriginal = original;
  window.fetch = guarded;
}

const xhrMeta = typeof WeakMap === 'undefined' ? undefined : new WeakMap<XMLHttpRequest, { method: string; url: string }>();

// Best-effort XHR fence. fetch is the primary path (BIG W's checkout and this
// bridge both use it); XHR is patched so a stray XMLHttpRequest POST to a
// financial endpoint is blocked the same way.
function installXhrGuard(): void {
  if (typeof XMLHttpRequest === 'undefined' || !xhrMeta) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = XMLHttpRequest.prototype as any;
  if (proto.__dukeGuard) return;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  proto.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]) {
    xhrMeta?.set(this, { method: String(method).toUpperCase(), url: String(url) });
    return originalOpen.apply(this, [method, url, ...rest]);
  };
  proto.send = function (this: XMLHttpRequest, body?: unknown) {
    const meta = xhrMeta?.get(this);
    const enabled = guardState.binding !== null;
    if (enabled && meta && meta.method === 'POST' && financialUrl(meta.url)) {
      let prevent: string | null = null;
      try {
        const decision = decideFinancial(meta.url, typeof body === 'string' ? body : undefined);
        prevent = 'prevent' in decision ? decision.prevent : null;
      } catch {
        notifyGuard({ type: 'uncertain' });
      }
      if (prevent) {
        notifyGuard({ type: 'prevented', code: prevent });
        queueMicrotask(() => {
          // Best-effort rejection of a blocked XHR: fire error + readystatechange
          // with status 0. Note this does NOT advance readyState to 4 — a caller
          // watching only for readyState 4 will simply never resolve. fetch is
          // the primary path (BIG W checkout and this bridge both use it).
          try { this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('readystatechange')); } catch { /* ignore */ }
        });
        return;
      }
    }
    return originalSend.call(this, body);
  };
  proto.__dukeGuard = true;
}

export function installGuard(): void {
  installFetchGuard();
  installXhrGuard();
}

function uninstallGuard(): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const current = window.fetch as WrappedFetch;
  if (current.__dukeOriginal) window.fetch = current.__dukeOriginal;
}

export interface ControlMessage { kind?: string; binding?: PaymentBinding }

function antiFraudFingerprint(): string {
  if (typeof window === 'undefined') return '';
  return (window as unknown as { gr4vyAntiFraud?: { f?: string } }).gr4vyAntiFraud?.f || '';
}

export function handleControl(control: ControlMessage): unknown {
  switch (control?.kind) {
    case 'guard.enable':
      if (!control.binding) return { ok: false };
      guardState.binding = { ...control.binding };
      guardState.sent = false;
      guardState.finalized = false;
      installGuard();
      return { ok: true };
    case 'guard.disable':
      guardState.binding = null;
      return { ok: true };
    case 'observe.list':
      return { entries: observeEntries.slice() };
    case 'observe.clear':
      observeEntries.length = 0;
      return { ok: true };
    case 'observe.antiFraud':
      return { fingerprint: antiFraudFingerprint() };
    default:
      return { ok: false };
  }
}

function reset(): void {
  guardState.binding = null;
  guardState.sent = false;
  guardState.finalized = false;
  observeEntries.length = 0;
  testHooks.forceDecisionError = false;
  uninstallGuard();
}

export async function handleMessage(message: { channel: string; requestId: string; kind?: string; args?: BridgeArgs & { scopes?: string[] }; control?: ControlMessage }, post: (msg: unknown) => void): Promise<void> {
  if (message?.channel !== CHANNEL || typeof message.requestId !== 'string') return;
  if (message.kind === 'context') {
    post({ channel: CHANNEL, requestId: message.requestId, result: pageContext() });
    return;
  }
  if (message.kind === 'control') {
    post({ channel: CHANNEL, requestId: message.requestId, result: handleControl(message.control ?? {}) });
    return;
  }
  if (typeof message.args !== 'object' || message.args === null) return;
  const scopes = message.args.publicRequest ? [] : (message.args.scopes ?? ['cart:view']);
  const token = message.args.publicRequest ? undefined : resolveToken(scopes)?.token;
  const result = await pageRequest({ ...message.args, token });
  post({ channel: CHANNEL, requestId: message.requestId, result });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  installGuard();
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    void handleMessage(event.data, msg => window.postMessage(msg, '*'));
  });
}

export const __test = {
  handleControl,
  guardState,
  observeEntries,
  reset,
  installGuard,
  get forceDecisionError(): boolean { return testHooks.forceDecisionError; },
  set forceDecisionError(value: boolean) { testHooks.forceDecisionError = value; },
};
