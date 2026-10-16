import { describe, expect, it, vi } from 'vitest';
import { BigWAdapter } from '../src/server/browser/bigw.ts';
import type { ConnectionState } from '../src/shared/types.ts';

function connection(page: unknown) {
  const state: ConnectionState = { status: 'connected', message: 'connected' };
  return { state, connect: async () => state, page: async () => page as never };
}

describe('working tab handling', () => {
  it('brings the working tab to the front for an explicit focus request', async () => {
    const page = { bringToFront: vi.fn(async () => undefined) };
    const adapter = new BigWAdapter(connection(page));
    await adapter.focus();
    expect(page.bringToFront).toHaveBeenCalledOnce();
  });

  it('resolves a fresh tab instead of failing on a stale reference', async () => {
    const bringToFront = vi.fn(async () => {
      throw new Error('Target closed');
    });
    const adapter = new BigWAdapter(connection({ bringToFront }));
    await expect(adapter.focus()).rejects.toThrow();
    expect(bringToFront).toHaveBeenCalledOnce();
  });
});

describe('arm()', () => {
  it('downgrades to a standby arm when the product cannot be checked out yet', async () => {
    const product = {
      code: '6071620', url: 'https://www.bigw.com.au/product/example/p/6071620', title: 'Example',
      imageUrl: '', priceCents: 1800, deliveryCents: 400, available: false,
      stockLabel: 'Releases soon', requiresVariant: false,
    };
    class StandbyAdapter extends BigWAdapter {
      override async inspect(): Promise<typeof product> { return product; }
    }
    const page = {
      url: () => 'https://www.bigw.com.au/product/example/p/6071620',
      evaluate: async () => ({ authenticated: true, tokenSecondsRemaining: 600, cartId: null, storeId: 'S1', delivery: null }),
      goto: async () => undefined,
      isClosed: () => false,
      on: () => undefined,
      off: () => undefined,
      setRequestInterception: async () => undefined,
    };
    const adapter = new StandbyAdapter(connection(page));
    const armed = await adapter.arm({
      productUrl: product.url, quantity: 1, maxTotalCents: 2500, mode: 'purchase',
      profile: { name: 'T', firstName: 'A', lastName: 'B', phone: '0412345678', deliveryAddress: { line1: '1 St', line2: '', suburb: 'Clayton', postcode: '3168', state: 'VIC', country: 'AU' }, billingSame: true },
    }, () => undefined, new AbortController().signal);
    expect(armed.level).toBe('standby');
    expect(armed.cartId).toBe('');
    expect(armed.note).toContain('release');
    expect(adapter.armedState()?.level).toBe('standby');
  });
});
