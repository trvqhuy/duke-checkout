import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import { createApp } from '../src/server/app.ts';
import { RunManager } from '../src/server/checkout.ts';
import { LocalStore } from '../src/server/storage.ts';
import type { Profile, StoreAdapter } from '../src/shared/types.ts';
import { profile, productUrl, runInput, testCard } from './fixtures.ts';

let server: Server, directory: string, origin: string, token: string, cookie: string;

beforeEach(async () => {
  directory = await mkdtemp('/tmp/opencode/duke-http-');
  const store = new LocalStore(directory);
  const product = { code: '6071620', url: productUrl, title: 'A book', priceCents: 1800, deliveryCents: 400, available: true, stockLabel: 'Pre-order' };
  const cart = { id: 'CT_example', version: 1, entries: [{ productCode: '6071620', quantity: 1 }], total: 2200, deliveryCost: 400, deliveryAddress: { ...profile.deliveryAddress, firstName: profile.firstName, lastName: profile.lastName, phonenumber: '+61412345678' }, billingAddress: profile.deliveryAddress, customer: { firstName: profile.firstName, lastName: profile.lastName, phone: '+61412345678' } };
  const adapter: StoreAdapter = {
    connect: async () => ({ status: 'connected', message: 'Connected' }), inspect: async () => product,
    prepare: async () => ({ cartId: cart.id, cart, product }), verify: async prepared => prepared.cart,
    fillCard: async () => {}, startAfterpay: async () => true, pay: async () => ({ status: 'confirmed', orderNumber: 'BW-TEST-1' }), clearSensitiveFields: async () => {},
  };
  const manager = new RunManager(store, adapter); await manager.init();
  const browser = Object.assign(new EventEmitter(), { state: { status: 'connected' as const, message: 'Connected' }, connect: adapter.connect });
  const app = createApp({ store, manager, browser, token: 'test-token', adapter: { inspect: adapter.inspect, importProfile: async () => ({ profile: profile as Profile, savedCards: [] }) } });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(`${origin}/api/bootstrap`);
  token = (await response.json()).csrfToken;
  cookie = response.headers.get('set-cookie')!.split(';')[0];
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

const post = (path: string, value: unknown, extra: Record<string, string> = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-local-token': token, origin, cookie, ...extra }, body: JSON.stringify(value) });

describe('local web API', () => {
  it('boots with the current connection and no profiles', async () => {
    const response = await fetch(`${origin}/api/bootstrap`);
    const result = await response.json();
    expect(result.profiles).toEqual([]);
    expect(result.connection.status).toBe('connected');
    expect(result.activeRunId).toBeNull();
  });

  it('rejects mutations without the local request token', async () => {
    const response = await post('/api/profiles', profile, { 'x-local-token': 'incorrect' });
    expect(response.status).toBe(403);
  });

  it.each(['/API/profiles', '/Api/profiles'])('protects a mixed-case mutation route: %s', async path => {
    const response = await post(path, profile, { 'x-local-token': 'incorrect' });
    expect(response.status).toBe(403);
  });

  it('rejects a foreign Origin even with the token', async () => {
    expect((await post('/api/profiles', profile, { origin: 'https://other.example' })).status).toBe(403);
  });

  it('rejects a foreign Host', async () => {
    const status = await new Promise<number>(resolve => {
      const request = httpRequest(`${origin}/api/bootstrap`, { headers: { host: 'other.example' } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
      request.end();
    });
    expect(status).toBe(403);
  });

  it('saves and deletes a contact profile', async () => {
    const response = await post('/api/profiles', profile);
    expect(response.status).toBe(201);
    const saved = (await response.json()).profile;
    expect(saved.phone).toBe('+61412345678');
    const removed = await fetch(`${origin}/api/profiles/${saved.id}`, { method: 'DELETE', headers: { 'x-local-token': token, origin, cookie } });
    expect(removed.status).toBe(200);
    expect((await (await fetch(`${origin}/api/bootstrap`)).json()).profiles).toEqual([]);
  });

  it('returns field errors without echoing invalid request data', async () => {
    const response = await post('/api/runs', { ...runInput, profile: { ...profile, phone: 'not-a-phone' } });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.fields['profile.phone']).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('not-a-phone');
  });

  it('accepts a run and exposes only public run data', async () => {
    const response = await post('/api/runs', { ...runInput, mode: 'purchase', card: testCard });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.run.id).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(testCard.number);
    expect(body.run.card).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 20));
    const run = (await (await fetch(`${origin}/api/runs/${body.run.id}`)).json()).run;
    expect(run.status).toBe('succeeded');
    expect(run.orderNumber).toBe('BW-TEST-1');
  });

  it('requires the local session cookie for the event stream', async () => {
    expect((await fetch(`${origin}/api/events`)).status).toBe(403);
    const response = await fetch(`${origin}/api/events`, { headers: { cookie } });
    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain('"type":"snapshot"');
    await reader.cancel();
  });
});
