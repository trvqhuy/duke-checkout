import { describe, expect, it } from 'vitest';
import { BigWExtensionAdapter } from '../../src/extension/lib/retailers/bigw/adapter.ts';
import type { RunAdapter } from '../../src/extension/background/run-manager.ts';
import type { ArmedCheckout } from '../../src/shared/types.ts';
import { productUrl, profile } from '../fixtures.ts';

const stubSender = (responses: Record<string, unknown>, called: string[] = []) => ({
  sendMessage: async (_tabId: number, msg: unknown) => {
    const key = ((msg as { args: { path: string } }).args.path).split('?')[0];
    called.push(key);
    if (!(key in responses)) throw new Error(`unexpected path ${key}`);
    return responses[key];
  },
});

describe('BigWExtensionAdapter', () => {
  it('inspects a product through the bridge and maps price/availability', async () => {
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({
      '/warehouse-customer/v1/postcode/2000': { ok: true, status: 200, data: [{ state: 'NSW', miraklZone: 'ZONE_1', zoneClassification: 'MIXED' }] },
      '/api/stores/v0/list': { ok: true, status: 200, data: [{ id: 'S1', name: 'Sydney Store', address: { state: 'NSW' } }] },
      '/apim/product-price-api/v1/products': { ok: true, status: 200, data: [{ code: '6071620', name: 'Example Book' }] }, // row shape per buildProductInfo's contract (top-level name/code)
      '/apim/product-price-api/v1/prices/6071620': { ok: true, status: 200, data: [{ price: { centAmount: 1800, fractionDigits: 2 } }] },
      '/api/availability/v0/product/6071620': { ok: false, status: 0, code: 'REQUEST_NETWORK' },
    }) }));
    const info = await adapter.inspect(productUrl, profile as never);
    expect(info.code).toBe('6071620');
    expect(info.priceCents).toBe(1800);
    expect(info.available).toBe(true); // advisory availability failure defers to cart fulfilment (server-parity)
  });
  it('lists saved cards through the bridge, dropping malformed entries (server parity)', async () => {
    const called: string[] = [];
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({
      '/storefront/v1/cart/saved-cards': { ok: true, status: 200, data: [
        { id: 'CARD-1', brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2037 },
        { id: 'CARD-2', brand: 'Visa', last4: '12' },
        { id: '', brand: 'Visa', last4: '1111' },
      ] },
    }, called) }));
    const cards = await adapter.listCards();
    expect(cards).toEqual([{ id: 'CARD-1', brand: 'Visa', last4: '4242', expiryMonth: 12, expiryYear: 2037 }]);
    expect(called).toEqual(['/storefront/v1/cart/saved-cards']);
  });
  it('arm() on an unavailable product downgrades to standby (same rule as the server app)', async () => {
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({}) }));
    adapter.inspect = async () => ({ code: '1', url: productUrl, title: 'X', imageUrl: '', priceCents: 100, deliveryCents: 0, available: false, stockLabel: '', requiresVariant: false } as never);
    const armed = await adapter.arm({ productUrl, quantity: 1, maxTotalCents: 2500, mode: 'purchase', profile: profile as never } as never, () => undefined, new AbortController().signal);
    expect(armed.level).toBe('standby');
  });
  it('arm() on an available product prepares the cart to cart-ready', async () => {
    const called: string[] = [];
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({
      '/warehouse-customer/v1/postcode/2000': { ok: true, status: 200, data: [{ state: 'NSW', miraklZone: 'ZONE_1', zoneClassification: 'MIXED' }] },
      '/api/stores/v0/list': { ok: true, status: 200, data: [{ id: 'S1', name: 'Sydney Store', address: { state: 'NSW' } }] },
      '/storefront/v1/cart/create': { ok: true, status: 200, data: { id: 'CT_abc', version: 1, total: 100, deliveryCost: 0, entries: [{ productCode: '1', quantity: 1 }] } },
      '/storefront/v1/cart/CT_abc/update-details': { ok: true, status: 200, data: null },
      '/storefront/v1/cart/CT_abc/fulfilment-preference': { ok: true, status: 200, data: null },
      '/storefront/v1/cart/CT_abc/billing-address': { ok: true, status: 200, data: null },
      '/storefront/v1/cart/CT_abc/recalculate': { ok: true, status: 200, data: null },
    }, called) }));
    adapter.inspect = async () => ({ code: '1', url: productUrl, title: 'X', imageUrl: '', priceCents: 100, deliveryCents: 0, available: true, stockLabel: '', requiresVariant: false } as never);
    const armed = await adapter.arm({ productUrl, quantity: 1, maxTotalCents: 2500, mode: 'purchase', profile: profile as never } as never, () => undefined, new AbortController().signal);
    expect(armed.level).toBe('cart-ready');
    expect(armed.cartId).toBe('CT_abc');
    // prepareCart never reuses an existing cart (stage-1 deviation), so no
    // cart-GET path is expected — location resolution, create, the three
    // mutations, then recalculate.
    expect(called).toEqual([
      '/warehouse-customer/v1/postcode/2000',
      '/api/stores/v0/list',
      '/storefront/v1/cart/create',
      '/storefront/v1/cart/CT_abc/update-details',
      '/storefront/v1/cart/CT_abc/fulfilment-preference',
      '/storefront/v1/cart/CT_abc/billing-address',
      '/storefront/v1/cart/CT_abc/recalculate',
    ]);
  });
  it('arm() publishes a cart-ready checkout to the injected store', async () => {
    const written: Array<ArmedCheckout | null> = [];
    const store = { get: () => null as ArmedCheckout | null, set: (armed: ArmedCheckout | null) => { written.push(armed); } };
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({
      '/warehouse-customer/v1/postcode/2000': { ok: true, status: 200, data: [{ state: 'NSW', miraklZone: 'ZONE_1', zoneClassification: 'MIXED' }] },
      '/api/stores/v0/list': { ok: true, status: 200, data: [{ id: 'S1', name: 'Sydney Store', address: { state: 'NSW' } }] },
      '/storefront/v1/cart/create': { ok: true, status: 200, data: { id: 'CT_abc', version: 1, total: 100, deliveryCost: 0, entries: [{ productCode: '1', quantity: 1 }] } },
      '/storefront/v1/cart/CT_abc/update-details': { ok: true, status: 200, data: null },
      '/storefront/v1/cart/CT_abc/fulfilment-preference': { ok: true, status: 200, data: null },
      '/storefront/v1/cart/CT_abc/billing-address': { ok: true, status: 200, data: null },
      '/storefront/v1/cart/CT_abc/recalculate': { ok: true, status: 200, data: null },
    }) }), store);
    adapter.inspect = async () => ({ code: '1', url: productUrl, title: 'X', imageUrl: '', priceCents: 100, deliveryCents: 0, available: true, stockLabel: '', requiresVariant: false } as never);
    const armed = await adapter.arm({ productUrl, quantity: 1, maxTotalCents: 2500, mode: 'purchase', profile: profile as never } as never, () => undefined, new AbortController().signal);
    expect(written).toEqual([armed]);
    expect(written[0]?.level).toBe('cart-ready');
  });
  it('arm() publishes a standby checkout to the injected store', async () => {
    const written: Array<ArmedCheckout | null> = [];
    const store = { get: () => null as ArmedCheckout | null, set: (armed: ArmedCheckout | null) => { written.push(armed); } };
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({}) }), store);
    adapter.inspect = async () => ({ code: '1', url: productUrl, title: 'X', imageUrl: '', priceCents: 100, deliveryCents: 0, available: false, stockLabel: '', requiresVariant: false } as never);
    const armed = await adapter.arm({ productUrl, quantity: 1, maxTotalCents: 2500, mode: 'purchase', profile: profile as never } as never, () => undefined, new AbortController().signal);
    expect(written).toEqual([armed]);
    expect(written[0]?.level).toBe('standby');
  });
  it('armedState() reflects the store and disarm() clears it', () => {
    const held: ArmedCheckout = { level: 'cart-ready', cartId: 'CT_abc', productCode: '1' } as ArmedCheckout;
    let current: ArmedCheckout | null = held;
    const store = { get: () => current, set: (armed: ArmedCheckout | null) => { current = armed; } };
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({}) }), store);
    expect(adapter.armedState()).toBe(held);
    adapter.disarm();
    expect(current).toBeNull();
    expect(adapter.armedState()).toBeNull();
  });
  it('satisfies the RunManager RunAdapter armed accessors', () => {
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({}) }));
    const runAdapter: RunAdapter = adapter;
    expect(runAdapter.armedState?.()).toBeNull();
  });
});
