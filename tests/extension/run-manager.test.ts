import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RunManager, type RunAdapter } from '../../src/extension/background/run-manager.ts';
import { AppError } from '../../src/server/errors.ts';
import { validateRun } from '../../src/shared/validation.ts';
import type { ArmedCheckout, CartState, PaymentOutcome, PreparedCheckout, ProductInfo } from '../../src/shared/types.ts';
import { productUrl, runInput, testCard } from '../fixtures.ts';

const mem: Record<string, unknown> = {};
const sessionMem: Record<string, unknown> = {};
const sent: Array<{ type: string; payload: unknown }> = [];
const chromeStub = {
  storage: {
    local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in mem).map(k => [k, mem[k]])),
      set: async (items: Record<string, unknown>) => { Object.assign(mem, items); },
    },
    session: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in sessionMem).map(k => [k, sessionMem[k]])),
      set: async (items: Record<string, unknown>) => { Object.assign(sessionMem, items); },
      remove: async (keys: string[]) => { for (const k of keys) delete sessionMem[k]; },
    },
  },
  runtime: { sendMessage: async (message: unknown) => { sent.push(message as { type: string; payload: unknown }); } },
};
(globalThis as Record<string, unknown>).chrome = chromeStub;

const product: ProductInfo = { code: '6071620', url: productUrl, title: 'A book', priceCents: 1800, deliveryCents: 400, available: true, stockLabel: 'Pre-order' };
const recipient = { firstName: runInput.profile.firstName, lastName: runInput.profile.lastName, phonenumber: '+61412345678' };
const makeCart = (): CartState => ({
  id: 'CT_example', version: 4, entries: [{ productCode: '6071620', quantity: 1 }], total: 2200, deliveryCost: 400,
  deliveryAddress: { ...runInput.profile.deliveryAddress, ...recipient },
  billingAddress: { ...runInput.profile.deliveryAddress, ...recipient },
  customer: { firstName: recipient.firstName, lastName: recipient.lastName, phone: recipient.phonenumber },
  validation: { isValid: true },
});
const cart = makeCart();

function makeAdapter() {
  const calls = { pay: 0, fill: 0, clear: 0, afterpay: 0, prepare: 0, verify: 0, inspect: 0, disarm: 0, reveal: 0 };
  const adapter: RunAdapter = {
    inspect: async () => { calls.inspect++; return product; },
    prepare: async (_input, item, report) => { calls.prepare++; report('cart', 'Cart prepared'); report('contact', 'Addresses applied'); return { cartId: cart.id, cart: structuredClone(cart), product: item }; },
    verify: async prepared => { calls.verify++; return prepared.cart; },
    fillCard: async () => { calls.fill++; },
    startAfterpay: async () => { calls.afterpay++; return true; },
    pay: async () => { calls.pay++; return { status: 'confirmed', orderNumber: 'BW-EXAMPLE-100' }; },
    clearSensitiveFields: async () => { calls.clear++; },
    revealPrepared: async () => { calls.reveal++; },
  };
  return { adapter, calls };
}

function makeArmed(level: 'cart-ready' | 'standby' = 'cart-ready'): ArmedCheckout {
  return {
    productUrl, productCode: '6071620', quantity: 1, maxTotalCents: 2500,
    profile: JSON.parse(JSON.stringify(validateRun(runInput).profile)),
    product, cartId: cart.id, cart: structuredClone(cart), armedAt: new Date().toISOString(), level,
  };
}

function runRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), requestId: randomUUID(), mode: 'purchase', status: 'running', stage: 'payment',
    productCode: '6071620', productUrl, quantity: 1, maxTotalCents: 2500, profileName: 'Home delivery',
    startedAt: now, updatedAt: now, elapsedMs: 0, events: [], ...overrides,
  };
}

async function setup() {
  const { adapter, calls } = makeAdapter();
  const manager = new RunManager(adapter);
  await manager.init();
  return { manager, adapter, calls };
}

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  for (const k of Object.keys(sessionMem)) delete sessionMem[k];
  sent.length = 0;
});

describe('extension RunManager', () => {
  it('completes prepare mode as ready without payment', async () => {
    const { manager, calls } = await setup();
    const done = await manager.wait((await manager.start(runInput)).id);
    expect(done.status).toBe('ready');
    expect(done.totalCents).toBe(2200);
    expect(calls.pay).toBe(0);
    expect(done.events.map(event => event.stage)).toContain('contact');
    expect(sent.some(event => event.type === 'run.update' && (event.payload as { status?: string }).status === 'ready')).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(testCard.number);
  });

  it('records a confirmed purchase with its order number', async () => {
    const { manager, calls } = await setup();
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(done.status).toBe('succeeded');
    expect(done.orderNumber).toBe('BW-EXAMPLE-100');
    expect(calls.pay).toBe(1);
  });

  it('distinguishes a decline, a block, and an unknown outcome', async () => {
    const declined = await setup();
    declined.adapter.pay = async (): Promise<PaymentOutcome> => ({ status: 'declined', message: 'Card was declined.' });
    const declinedRun = await declined.manager.wait((await declined.manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(declinedRun.status).toBe('failed');
    expect(declinedRun.error?.code).toBe('PAYMENT_DECLINED');

    const blocked = await setup();
    blocked.adapter.pay = async (): Promise<PaymentOutcome> => ({ status: 'blocked', code: 'CARD_SESSION', message: 'No payment was submitted.' });
    const blockedRun = await blocked.manager.wait((await blocked.manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(blockedRun.status).toBe('failed');
    expect(blockedRun.error?.code).toBe('CARD_SESSION');
    expect(blockedRun.paymentSubmittedAt).toBeUndefined();

    const unknown = await setup();
    unknown.adapter.pay = async (): Promise<PaymentOutcome> => ({ status: 'unknown', message: 'Outcome not confirmed.' });
    const unknownRun = await unknown.manager.wait((await unknown.manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(unknownRun.status).toBe('payment_unknown');
  });

  it('fills only in assist mode and keeps the card in the fields', async () => {
    const { manager, calls } = await setup();
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'assist', card: testCard })).id);
    expect(done.status).toBe('ready');
    expect(done.paymentSubmittedAt).toBeUndefined();
    expect(calls.fill).toBe(1);
    expect(calls.pay).toBe(0);
    expect(calls.clear).toBe(0);
    expect(calls.verify).toBeGreaterThan(0);
  });

  it('honors cancellation before submission', async () => {
    const { manager, adapter, calls } = await setup();
    let reached!: () => void;
    const reachedPrepare = new Promise<void>(resolve => { reached = resolve; });
    adapter.prepare = (_input, _product, _report, signal) => {
      reached();
      return new Promise<PreparedCheckout>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
      });
    };
    const first = await manager.start({ ...runInput, mode: 'purchase', card: testCard });
    await reachedPrepare;
    manager.cancel(first.id);
    expect((await manager.wait(first.id)).status).toBe('cancelled');
    expect(calls.pay).toBe(0);
  });

  it('uses an armed cart-ready fast path when it matches', async () => {
    const { manager, adapter, calls } = await setup();
    adapter.armedState = () => makeArmed('cart-ready');
    adapter.disarm = () => { calls.disarm++; };
    const done = await manager.wait((await manager.start(runInput)).id);
    expect(done.status).toBe('ready');
    expect(calls.prepare).toBe(0);
    expect(calls.inspect).toBe(0);
    expect(calls.verify).toBe(1);
    expect(calls.reveal).toBe(1);
    expect(calls.disarm).toBe(0);
  });

  it('falls back to a full preparation when the armed cart is unusable', async () => {
    const { manager, adapter, calls } = await setup();
    adapter.armedState = () => makeArmed('cart-ready');
    let verifyCount = 0;
    adapter.verify = async prepared => {
      verifyCount++;
      if (verifyCount === 1) throw new AppError('CART_CHANGED', 'The armed cart changed.');
      return prepared.cart;
    };
    adapter.disarm = () => { calls.disarm++; };
    const done = await manager.wait((await manager.start(runInput)).id);
    expect(done.status).toBe('ready');
    expect(calls.disarm).toBe(1);
    expect(calls.prepare).toBe(1);
    expect(calls.inspect).toBe(1);
  });

  it('blocks an authoritative total over the spending limit', async () => {
    const { manager, adapter, calls } = await setup();
    adapter.verify = async prepared => ({ ...prepared.cart, total: 2600 });
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(done.error?.code).toBe('BUDGET');
    expect(calls.pay).toBe(0);
  });

  it('treats repeated creation with the same request ID as the same run', async () => {
    const { manager, calls } = await setup();
    const request = { ...runInput, requestId: randomUUID(), mode: 'purchase', card: testCard };
    const first = await manager.start(request);
    const second = await manager.start(request);
    expect(second.id).toBe(first.id);
    await manager.wait(first.id);
    expect(calls.pay).toBe(1);
  });

  it('excludes a second active checkout', async () => {
    const { manager, adapter } = await setup();
    let release!: (value: ProductInfo) => void;
    adapter.inspect = () => new Promise(resolve => { release = resolve; });
    const first = await manager.start(runInput);
    await expect(manager.start(runInput)).rejects.toThrow(/already running/i);
    await new Promise(resolve => setTimeout(resolve, 0));
    release(product);
    await manager.wait(first.id);
  });

  it('recovers an interrupted post-submission run as unknown after init', async () => {
    mem.dukeHistory = [runRecord({ paymentSubmittedAt: new Date().toISOString() })];
    const { adapter } = makeAdapter();
    const restarted = new RunManager(adapter);
    await restarted.init();
    expect(restarted.history()[0].status).toBe('payment_unknown');
    expect(restarted.history()[0].error?.code).toBe('PAYMENT_UNKNOWN');
  });

  it('recovers an interrupted pre-submission run as a failed INTERRUPTED run', async () => {
    mem.dukeHistory = [runRecord()];
    const { adapter } = makeAdapter();
    const restarted = new RunManager(adapter);
    await restarted.init();
    expect(restarted.history()[0].status).toBe('failed');
    expect(restarted.history()[0].error?.code).toBe('INTERRUPTED');
  });

  it('recovers an unfinished session run that never reached history', async () => {
    sessionMem.dukeRunState = { run: runRecord({ id: 'session-only', paymentSubmittedAt: new Date().toISOString() }) };
    const { adapter } = makeAdapter();
    const restarted = new RunManager(adapter);
    await restarted.init();
    expect(restarted.history()[0].id).toBe('session-only');
    expect(restarted.history()[0].status).toBe('payment_unknown');
    expect(sessionMem.dukeRunState).toBeUndefined();
  });
});
