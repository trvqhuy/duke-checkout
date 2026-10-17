import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { resolveToken, pageRequest, pageContext, handleMessage, scopesForPath, __test, type ObservedEntry } from '../../src/extension/content/api-bridge-main.ts';

const localStorageStub = (data: Record<string, string>) => {
  const store = new Map(Object.entries(data));
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, key: (i: number) => Array.from(store.keys())[i] ?? null, get length() { return store.size; } });
};

describe('api-bridge main world', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('resolves the newest scoped token from the Auth0 SPA cache', () => {
    localStorageStub({
      '@@auth0spajs@@::client1::https://api.bigw.com.au/api::openid profile cart:manage': JSON.stringify({
        expiresAt: 9999999999, body: { access_token: 'tok1', client_id: 'client1', scope: 'openid profile cart:manage' },
      }),
    });
    vi.stubGlobal('document', { cookie: '' });
    expect(resolveToken(['cart:manage'])?.token).toBe('tok1');
    expect(resolveToken(['payment:manage'])).toBeNull();
  });
  it('pageRequest returns ok:false on HTTP 403 with BROWSER_ATTENTION', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    const result = await pageRequest({ origin: 'https://api.bigw.com.au', path: '/storefront/v1/cart/create', method: 'POST', publicRequest: false, token: 't' });
    expect(result).toEqual({ ok: false, status: 403, code: 'BROWSER_ATTENTION' });
  });
  it('handleMessage answers postMessage protocol requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ hello: 1 })));
    vi.stubGlobal('document', { cookie: '' });
    localStorageStub({});
    const replies: unknown[] = [];
    const post = vi.fn((msg: unknown) => replies.push(msg));
    vi.stubGlobal('window', { addEventListener: () => undefined, postMessage: post } as unknown as Window);
    await handleMessage({ channel: 'duke', requestId: 'x', args: { origin: 'https://api.bigw.com.au', path: '/ping', method: 'GET', publicRequest: true } }, post);
    expect(replies[0]).toMatchObject({ channel: 'duke', requestId: 'x', result: { ok: true, status: 200, data: { hello: 1 } } });
  });
  it('handleMessage ignores its own reply echoes without args', async () => {
    const post = vi.fn();
    await expect(handleMessage({ channel: 'duke', requestId: 'echo', args: undefined as never }, post)).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });
  it('pageRequest rejects unknown origins and malformed paths with REQUEST_ORIGIN', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await pageRequest({ origin: 'https://evil.example', path: '/x', publicRequest: true })).toEqual({ ok: false, status: 0, code: 'REQUEST_ORIGIN' });
    expect(await pageRequest({ origin: 'https://api.bigw.com.au', path: 'storefront/v1/cart', publicRequest: true })).toEqual({ ok: false, status: 0, code: 'REQUEST_ORIGIN' });
    expect(await pageRequest({ origin: 'https://api.bigw.com.au', path: '//evil.example/x', publicRequest: true })).toEqual({ ok: false, status: 0, code: 'REQUEST_ORIGIN' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('pageRequest picks authorization for /profile/ paths and authorization3 otherwise', async () => {
    const seen: string[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { headers: Record<string, string> }) => { seen.push(Object.keys(init.headers)); return Response.json({}); }));
    await pageRequest({ origin: 'https://api.bigw.com.au', path: '/profile/v1/me', method: 'GET', publicRequest: false, token: 't' });
    await pageRequest({ origin: 'https://api.bigw.com.au', path: '/storefront/v1/cart', method: 'GET', publicRequest: false, token: 't' });
    expect(seen).toEqual([['accept', 'authorization'], ['accept', 'authorization3']]);
  });
  it('pageContext ports PAGE_CONTEXT: auth state, expiry, cartId, store, delivery', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers({ now });
    try {
      localStorageStub({
        '@@auth0spajs@@::client1::https://api.bigw.com.au/api::openid profile cart:view': JSON.stringify({
          expiresAt: now / 1000 + 95, body: { access_token: 'tok1', client_id: 'client1', scope: 'openid profile cart:view' },
        }),
        'bigw:state-cartId': JSON.stringify('CT_123'),
      });
      vi.stubGlobal('document', {
        cookie: [
          'auth0.client1.is.authenticated=1',
          `bigw_location-store=${encodeURIComponent(JSON.stringify('S_10'))}`,
          `bigw_location-delivery=${encodeURIComponent(JSON.stringify({ postcode: '2000' }))}`,
        ].join('; '),
      });
      const context = pageContext();
      expect(context.authenticated).toBe(true);
      expect(context.tokenSecondsRemaining).toBe(95);
      expect(context.cartId).toBe('CT_123');
      expect(context.storeId).toBe('S_10');
      expect(context.delivery).toEqual({ postcode: '2000' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('pageContext reports anonymous state and tolerates malformed cookies and cart ids', () => {
    vi.stubGlobal('document', { cookie: 'bigw_location-store=%7Bbroken' });
    localStorageStub({ 'bigw:state-cartId': 'not-json' });
    const context = pageContext();
    expect(context).toEqual({ authenticated: false, tokenSecondsRemaining: 0, cartId: null, storeId: null, delivery: null });
  });
  it('handleMessage answers kind:context without touching args or fetch', async () => {
    vi.stubGlobal('document', { cookie: '' });
    localStorageStub({});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const replies: unknown[] = [];
    const post = vi.fn((msg: unknown) => replies.push(msg));
    await handleMessage({ channel: 'duke', requestId: 'ctx', kind: 'context', args: null as never }, post);
    expect(replies[0]).toMatchObject({ channel: 'duke', requestId: 'ctx', result: { authenticated: false, tokenSecondsRemaining: 0 } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('scopesForPath maps paths and methods to the required scopes', () => {
    expect(scopesForPath('/profile/v1/me', 'GET')).toEqual(['account:view', 'account:pii:view']);
    expect(scopesForPath('/storefront/v1/payment/saved-cards', 'GET')).toEqual(['payment:view']);
    expect(scopesForPath('/storefront/v1/payment-options', 'GET')).toEqual(['payment:view']);
    expect(scopesForPath('/pay', 'POST')).toEqual(['payment:manage', 'payment:authorise']);
    expect(scopesForPath('/pay/confirm', 'GET')).toEqual(['payment:manage', 'payment:authorise']);
    expect(scopesForPath('/storefront/v1/cart/create', 'POST')).toEqual(['cart:manage']);
    expect(scopesForPath('/storefront/v1/cart', 'GET')).toEqual(['cart:view']);
  });
});

const binding = { cartId: 'CT_example', cartVersion: 4, totalCents: 2200, kind: 'new' as const, sessionId: 'current-session' };
const payUrl = 'https://api.bigw.com.au/storefront/v1/cart/CT_example/pay';
const payload = () => ({ cartId: 'CT_example', cartVersion: 4, transactions: { creditCardPaymentInfo: { amountInCents: 2200, sessionId: 'current-session' } } });

function setupGuardWindow() {
  const posted: unknown[] = [];
  const original = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('gr4vy.app')) return new Response('vault-ok', { status: 200 });
    return Response.json({ orderNumber: 'ORD-1', status: 'CONFIRMED' });
  });
  const win = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    postMessage: (msg: unknown) => { posted.push(msg); },
    fetch: original,
    gr4vyAntiFraud: { f: 'fp-xyz' },
  };
  vi.stubGlobal('window', win as unknown as Window);
  return { win, posted, original };
}

describe('api-bridge main-world payment guard and observer', () => {
  beforeEach(() => { __test.reset(); vi.unstubAllGlobals(); });
  afterEach(() => { __test.reset(); vi.unstubAllGlobals(); });

  it('guard.enable blocks a violating /pay POST without hitting the network', async () => {
    const { win, posted, original } = setupGuardWindow();
    __test.handleControl({ kind: 'guard.enable', binding });
    const violating = { ...payload(), transactions: { creditCardPaymentInfo: { amountInCents: 9999, sessionId: 'current-session' } } };
    await expect((win.fetch as typeof fetch)(payUrl, { method: 'POST', body: JSON.stringify(violating) })).rejects.toThrow(TypeError);
    expect(original).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ channel: 'duke', kind: 'guard.event', event: { type: 'prevented', code: 'PAYMENT_CHANGED' } });
  });

  it('allows a matching /pay POST once and reports sent', async () => {
    const { win, posted, original } = setupGuardWindow();
    __test.handleControl({ kind: 'guard.enable', binding });
    const response = await (win.fetch as typeof fetch)(payUrl, { method: 'POST', body: JSON.stringify(payload()) });
    expect(response.status).toBe(200);
    expect(original).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({ channel: 'duke', kind: 'guard.event', event: { type: 'sent' } });
  });

  it('blocks a second /pay after a send as a duplicate', async () => {
    const { win, original, posted } = setupGuardWindow();
    __test.handleControl({ kind: 'guard.enable', binding });
    await (win.fetch as typeof fetch)(payUrl, { method: 'POST', body: JSON.stringify(payload()) });
    await expect((win.fetch as typeof fetch)(payUrl, { method: 'POST', body: JSON.stringify(payload()) })).rejects.toThrow(TypeError);
    expect(original).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({ channel: 'duke', kind: 'guard.event', event: { type: 'prevented', code: 'PAYMENT_DUPLICATE' } });
  });

  it('only allows a finalize after a send and marks finalized', async () => {
    const { win, original } = setupGuardWindow();
    __test.handleControl({ kind: 'guard.enable', binding });
    const finalize = `${payUrl}/finalize`;
    await expect((win.fetch as typeof fetch)(finalize, { method: 'POST', body: JSON.stringify({ cartId: 'CT_example' }) })).rejects.toThrow(TypeError);
    await (win.fetch as typeof fetch)(payUrl, { method: 'POST', body: JSON.stringify(payload()) });
    await (win.fetch as typeof fetch)(finalize, { method: 'POST', body: JSON.stringify({ cartId: 'CT_example', amountInCents: 2200 }) });
    await expect((win.fetch as typeof fetch)(finalize, { method: 'POST', body: JSON.stringify({ cartId: 'CT_example' }) })).rejects.toThrow(TypeError);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it('observes payment and vault POSTs and returns them via observe.list', async () => {
    const { win } = setupGuardWindow();
    __test.installGuard();
    const vaultUrl = 'https://api.wpay2.gr4vy.app/checkout/sessions/sess-1/card-details';
    await (win.fetch as typeof fetch)(payUrl, { method: 'POST', body: JSON.stringify(payload()) });
    await (win.fetch as typeof fetch)(vaultUrl, { method: 'POST', body: '{}' });
    const listed = __test.handleControl({ kind: 'observe.list' }) as { entries: ObservedEntry[] };
    expect(listed.entries).toHaveLength(2);
    expect(listed.entries[0]).toMatchObject({ url: payUrl, method: 'POST', status: 200 });
    expect(listed.entries[1]).toMatchObject({ url: vaultUrl, method: 'POST', status: 200, bodyText: 'vault-ok' });
  });

  it('records status 0 when an observed request fails at the network', async () => {
    const posted: unknown[] = [];
    const original = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, postMessage: (m: unknown) => { posted.push(m); }, fetch: original } as unknown as Window);
    __test.handleControl({ kind: 'guard.enable', binding });
    await expect((window.fetch as typeof fetch)(payUrl, { method: 'POST', body: JSON.stringify(payload()) })).rejects.toThrow('offline');
    const listed = __test.handleControl({ kind: 'observe.list' }) as { entries: ObservedEntry[] };
    expect(listed.entries).toContainEqual({ url: payUrl, method: 'POST', status: 0, bodyText: '' });
    expect(posted).toContainEqual({ channel: 'duke', kind: 'guard.event', event: { type: 'uncertain' } });
  });

  it('guard.disable restores pass-through', async () => {
    const { win, original, posted } = setupGuardWindow();
    __test.handleControl({ kind: 'guard.enable', binding });
    __test.handleControl({ kind: 'guard.disable' });
    await (win.fetch as typeof fetch)(payUrl, { method: 'POST', body: JSON.stringify({ ...payload(), cartVersion: 5 }) });
    expect(original).toHaveBeenCalledTimes(1);
    expect(posted.some(msg => (msg as { kind?: string }).kind === 'guard.event')).toBe(false);
  });

  it('observe.antiFraud returns the page fingerprint', () => {
    setupGuardWindow();
    expect(__test.handleControl({ kind: 'observe.antiFraud' })).toEqual({ fingerprint: 'fp-xyz' });
  });

  it('handleMessage routes kind:control to handleControl', async () => {
    setupGuardWindow();
    const replies: unknown[] = [];
    await handleMessage({ channel: 'duke', requestId: 'c1', kind: 'control', control: { kind: 'guard.enable', binding } }, msg => replies.push(msg));
    expect(replies[0]).toMatchObject({ channel: 'duke', requestId: 'c1', result: { ok: true } });
  });
});
