import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { armedMatches, RunManager } from '../src/server/checkout.ts';
import { LocalStore } from '../src/server/storage.ts';
import type { CartState, PaymentOutcome, PreparedCheckout, ProductInfo, StoreAdapter } from '../src/shared/types.ts';
import { productUrl, runInput, testCard } from './fixtures.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const product: ProductInfo = { code: '6071620', url: productUrl, title: 'A book', priceCents: 1800, deliveryCents: 400, available: true, stockLabel: 'Pre-order' };
const recipient = { firstName: runInput.profile.firstName, lastName: runInput.profile.lastName, phonenumber: '+61412345678' };
const cart: CartState = { id: 'CT_example', version: 4, entries: [{ productCode: '6071620', quantity: 1 }], total: 2200, deliveryCost: 400, deliveryAddress: { ...runInput.profile.deliveryAddress, ...recipient }, billingAddress: { ...runInput.profile.deliveryAddress, ...recipient }, customer: { firstName: recipient.firstName, lastName: recipient.lastName, phone: recipient.phonenumber }, validation: { isValid: true } };

function fakeAdapter() {
  let payCalls = 0, fillCalls = 0, clearCalls = 0, afterpayCalls = 0;
  const adapter: StoreAdapter = {
    connect: async () => ({ status: 'connected', message: 'Connected' }),
    inspect: async () => product,
    prepare: async (_input, item, report) => { report('cart', 'Cart prepared'); report('contact', 'Addresses applied'); return { cartId: cart.id, cart: structuredClone(cart), product: item }; },
    verify: async prepared => prepared.cart,
    fillCard: async () => { fillCalls++; },
    startAfterpay: async () => { afterpayCalls++; return true; },
    pay: async () => { payCalls++; return { status: 'confirmed', orderNumber: 'BW-EXAMPLE-100' }; },
    clearSensitiveFields: async () => { clearCalls++; },
  };
  return { adapter, calls: () => ({ pay: payCalls, fill: fillCalls, clear: clearCalls, afterpay: afterpayCalls }) };
}

async function setup() {
  const dir = await mkdtemp('/tmp/opencode/duke-run-'); directories.push(dir);
  const store = new LocalStore(dir);
  const { adapter, calls } = fakeAdapter();
  const manager = new RunManager(store, adapter);
  await manager.init();
  return { manager, adapter, calls, store };
}

describe('checkout coordination', () => {
  it('fills the card without submitting and keeps it in fill-only mode', async () => {
    const { manager, calls } = await setup();
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'assist', card: testCard })).id);
    expect(done.status).toBe('ready');
    expect(done.paymentSubmittedAt).toBeUndefined();
    expect(calls().fill).toBe(1);
    expect(calls().pay).toBe(0);
    expect(calls().clear).toBe(0);
  });

  it('opens Afterpay without a card and without submitting', async () => {
    const { manager, calls } = await setup();
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'afterpay' })).id);
    expect(done.status).toBe('ready');
    expect(calls().afterpay).toBe(1);
    expect(calls().pay).toBe(0);
    expect(calls().fill).toBe(0);
  });

  it('prepares a valid checkout without attempting payment', async () => {
    const { manager, calls } = await setup();
    const started = await manager.start(runInput);
    const done = await manager.wait(started.id);
    expect(done.status).toBe('ready');
    expect(done.totalCents).toBe(2200);
    expect(calls().pay).toBe(0);
    expect(done.events.map(event => event.stage)).toContain('contact');
  });

  it('blocks an authoritative total over the spending limit', async () => {
    const { manager, adapter, calls } = await setup();
    adapter.verify = async prepared => ({ ...prepared.cart, total: 2600 });
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(done.error?.code).toBe('BUDGET');
    expect(calls().pay).toBe(0);
  });

  it('blocks an unexpected item in the actual checkout cart', async () => {
    const { manager, adapter, calls } = await setup();
    adapter.verify = async prepared => ({ ...prepared.cart, entries: [...prepared.cart.entries, { productCode: '9999999', quantity: 1 }] });
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(done.error?.code).toBe('CART_CHANGED');
    expect(calls().pay).toBe(0);
  });

  it('blocks a delivery address changed by the native checkout', async () => {
    const { manager, adapter, calls } = await setup();
    adapter.verify = async prepared => ({ ...prepared.cart, deliveryAddress: { line1: '99 Another Road', suburb: 'Sydney', postcode: '2000', state: 'NSW' } });
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(done.error?.code).toBe('ADDRESS_CHANGED');
    expect(calls().pay).toBe(0);
  });

  it('does not collapse a unit separator into a different street number', async () => {
    const { manager, adapter, calls } = await setup();
    adapter.verify = async prepared => ({ ...prepared.cart, deliveryAddress: { ...prepared.cart.deliveryAddress, line1: '123 Market Street' }, billingAddress: { ...prepared.cart.billingAddress, line1: '123 Market Street' } });
    const input = { ...runInput, mode: 'purchase', card: testCard, profile: { ...runInput.profile, deliveryAddress: { ...runInput.profile.deliveryAddress, line1: '1/23 Market Street' } } };
    const done = await manager.wait((await manager.start(input)).id);
    expect(done.error?.code).toBe('ADDRESS_CHANGED');
    expect(calls().pay).toBe(0);
  });

  it('verifies the actual recipient and delivery phone', async () => {
    const { manager, adapter, calls } = await setup();
    adapter.verify = async prepared => ({ ...prepared.cart, customer: { firstName: 'Different', lastName: 'Recipient', phone: '+61498765432' } });
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(done.error?.code).toBe('CONTACT_CHANGED');
    expect(calls().pay).toBe(0);
  });

  it('submits once and records the merchant order reference without payment secrets', async () => {
    const { manager, calls, store } = await setup();
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(done.status).toBe('succeeded');
    expect(done.orderNumber).toBe('BW-EXAMPLE-100');
    expect(calls().pay).toBe(1);
    const history = JSON.stringify(await store.runs());
    expect(history).not.toContain(testCard.number);
    expect(history).not.toContain('"cvv"');
    expect(history).not.toContain('"expiry"');
  });

  it('treats repeated creation with the same request ID as the same run', async () => {
    const { manager, calls } = await setup();
    const request = { ...runInput, requestId: randomUUID(), mode: 'purchase', card: testCard };
    const first = await manager.start(request);
    const second = await manager.start(request);
    expect(second.id).toBe(first.id);
    await manager.wait(first.id);
    expect(calls().pay).toBe(1);
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

  it('honors cancellation before submission', async () => {
    const { manager, adapter, calls } = await setup();
    let release!: (value: PreparedCheckout) => void;
    let reached!: () => void;
    const reachedPrepare = new Promise<void>(resolve => { reached = resolve; });
    adapter.prepare = () => { reached(); return new Promise(resolve => { release = resolve; }); };
    const first = await manager.start({ ...runInput, mode: 'purchase', card: testCard });
    await reachedPrepare;
    manager.cancel(first.id);
    release({ cartId: cart.id, cart, product });
    expect((await manager.wait(first.id)).status).toBe('cancelled');
    expect(calls().pay).toBe(0);
  });

  it('records an ambiguous result but still allows another purchase', async () => {
    const { manager, adapter } = await setup();
    adapter.pay = async () => { throw new Error('network disconnected'); };
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(done.status).toBe('payment_unknown');
    // No hard block: a later purchase is allowed and the unknown run can be resolved.
    adapter.pay = async () => ({ status: 'confirmed', orderNumber: 'BW-CHECKED-101' });
    expect((await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id)).status).toBe('succeeded');
    await manager.resolve(done.id, 'not_purchased');
    expect(manager.get(done.id).status).toBe('failed');
  });

  it('distinguishes a definite rejection from an unknown result', async () => {
    const { manager, adapter } = await setup();
    adapter.pay = async (): Promise<PaymentOutcome> => ({ status: 'declined', message: 'Card was declined.' });
    const done = await manager.wait((await manager.start({ ...runInput, mode: 'purchase', card: testCard })).id);
    expect(done.status).toBe('failed');
    expect(done.error?.code).toBe('PAYMENT_DECLINED');
  });

  it('recovers an interrupted post-submission run as unknown after restart', async () => {
    const { manager, store, adapter } = await setup();
    const done = await manager.wait((await manager.start(runInput)).id);
    await store.saveRuns([{ ...done, mode: 'purchase', status: 'running', stage: 'payment', paymentSubmittedAt: new Date().toISOString(), finishedAt: undefined }]);
    const restarted = new RunManager(store, adapter);
    await restarted.init();
    expect(restarted.history()[0].status).toBe('payment_unknown');
  });
});

describe('armedMatches', () => {
  const armedBase = {
    productUrl, productCode: '6071620', quantity: 1, maxTotalCents: 2500,
    profile: JSON.parse(JSON.stringify(runInput.profile)),
    product: {} as ProductInfo, cartId: 'CT_x', cart: {} as CartState, armedAt: new Date().toISOString(),
    level: 'cart-ready' as const,
  };
  const input = { ...runInput, maxTotalCents: 2500 } as Parameters<typeof armedMatches>[1];

  it('matches the same product, quantity, and profile', () => {
    expect(armedMatches(armedBase, input)).toBe(true);
  });

  it('does not match a different product link, quantity, or contact detail', () => {
    expect(armedMatches({ ...armedBase, productUrl: productUrl.replace('6071620', '1234567') }, input)).toBe(false);
    expect(armedMatches({ ...armedBase, quantity: 2 }, input)).toBe(false);
    expect(armedMatches({ ...armedBase, profile: { ...armedBase.profile, phone: '0499999999' } }, input)).toBe(false);
    expect(armedMatches({ ...armedBase, profile: { ...armedBase.profile, deliveryAddress: { ...armedBase.profile.deliveryAddress, postcode: '3000' } } }, input)).toBe(false);
  });

  it('ignores the run budget: guardCart re-checks the live total', () => {
    expect(armedMatches(armedBase, { ...input, maxTotalCents: 1000 })).toBe(true);
  });
});
