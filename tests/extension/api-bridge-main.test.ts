import { describe, expect, it, vi, afterEach } from 'vitest';
import { resolveToken, pageRequest, handleMessage, scopesForPath } from '../../src/extension/content/api-bridge-main.ts';

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
