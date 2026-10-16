import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { PAGE_REQUEST } from '../src/server/browser/page-api.ts';

function execute(args: Record<string, unknown>, options: { token?: boolean; status?: number; entries?: Record<string, string> } = {}) {
  let captured: RequestInit | undefined;
  const cache = { body: { access_token: 'synthetic-session-secret' }, expiresAt: Date.now() / 1000 + 500 };
  const values = options.entries ?? (options.token === false ? {} : { '@@auth0spajs@@::client::https://api.bigw.com.au/api::cart:view account:view account:pii:view payment:view': JSON.stringify(cache) });
  const storage = Object.assign({}, values, { getItem: (key: string) => (values as Record<string, string>)[key] ?? null });
  const context = {
    localStorage: storage, document: { getElementById: () => null, cookie: '' }, AbortSignal, JSON, Date, URL,
    fetch: async (_url: string, init: RequestInit) => { captured = init; return new Response(JSON.stringify(options.status === 403 ? { message: 'sensitive-session-secret' } : { total: 2200 }), { status: options.status ?? 200, headers: { 'content-type': 'application/json' } }); },
  };
  const result = runInNewContext(`(${PAGE_REQUEST})(${JSON.stringify(args)})`, context) as Promise<Record<string, unknown>>;
  return { result, captured: () => captured };
}

describe('in-page BIG W requests', () => {
  it('keeps the token in the page and uses the observed storefront header', async () => {
    const probe = execute({ origin: 'https://api.bigw.com.au', path: '/storefront/v1/cart/example', method: 'GET' });
    const response = await probe.result;
    expect(response.ok).toBe(true);
    expect((probe.captured()?.headers as Record<string, string>).authorization3).toBe('Bearer synthetic-session-secret');
    expect(JSON.stringify(response)).not.toContain('synthetic-session-secret');
  });

  it('uses the profile API authentication convention', async () => {
    const probe = execute({ origin: 'https://api.bigw.com.au', path: '/profile/v1/addresses', method: 'GET' });
    await probe.result;
    expect((probe.captured()?.headers as Record<string, string>).authorization).toBe('Bearer synthetic-session-secret');
  });

  it('does not issue an authenticated request without a session', async () => {
    const probe = execute({ origin: 'https://api.bigw.com.au', path: '/storefront/v1/cart/example', method: 'GET' }, { token: false });
    expect((await probe.result).code).toBe('LOGIN_REQUIRED');
    expect(probe.captured()).toBeUndefined();
  });

  it('rejects arbitrary request origins', async () => {
    const probe = execute({ origin: 'https://other.example', path: '/anything', method: 'GET' });
    expect((await probe.result).ok).toBe(false);
    expect(probe.captured()).toBeUndefined();
  });

  it('does not return raw backend error bodies', async () => {
    const probe = execute({ origin: 'https://api.bigw.com.au', path: '/storefront/v1/cart/example', method: 'GET' }, { status: 403 });
    expect((await probe.result).ok).toBe(false);
    expect(JSON.stringify(await probe.result)).not.toContain('sensitive-session-secret');
  });

  it('selects a fresh matching-scope token instead of the first expired cache entry', async () => {
    const probe = execute({ origin: 'https://api.bigw.com.au', path: '/storefront/v1/cart/example', method: 'GET' }, { entries: {
      '@@auth0spajs@@::client::https://api.bigw.com.au/api::cart:view': JSON.stringify({ body: { access_token: 'expired-token' }, expiresAt: Date.now() / 1000 - 60 }),
      '@@auth0spajs@@::client::https://api.bigw.com.au/api::cart:view cart:manage': JSON.stringify({ body: { access_token: 'fresh-token' }, expiresAt: Date.now() / 1000 + 500 }),
    } });
    expect((await probe.result).ok).toBe(true);
    expect((probe.captured()?.headers as Record<string, string>).authorization3).toBe('Bearer fresh-token');
  });
});
