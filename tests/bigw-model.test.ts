import { describe, expect, it } from 'vitest';
import { buildProductInfo, parseCartState } from '../src/server/browser/bigw-model.ts';
import { productUrl } from './fixtures.ts';

describe('BIG W response interpretation', () => {
  it('recognizes a delivery preorder even when its reported quantity is zero', () => {
    const product = buildProductInfo(productUrl,
      [{ code: '6071620', name: 'A preorder book', soldByItself: true, variants: [{ images: [{ url: 'https://www.bigw.com.au/medias/book.jpg' }] }] }],
      [{ price: { centAmount: 1800 }, label: 'PRE-ORDER' }],
      { products: { '6071620': { delivery: { 'Standard Delivery': { available: true, quantity: 0, estimatedDelivery: '27–30 October' } }, minDeliveryFee: 400 } } });
    expect(product.available).toBe(true);
    expect(product.stockLabel).toBe('Pre-order');
    expect(product.priceCents).toBe(1800);
    expect(product.deliveryCents).toBe(400);
    expect(product.imageUrl).toBe('https://www.bigw.com.au/medias/book.jpg');
  });

  it('defers to the cart when the advisory availability lookup is missing', () => {
    const product = buildProductInfo(productUrl, [{ code: '6071620', name: 'A book' }], [{ price: { centAmount: 1800 } }], {});
    expect(product.available).toBe(true);
    expect(product.stockLabel).toBe('Availability checked at checkout');
  });

  it('uses the selected article variant even when the parent is not sold by itself', () => {
    const product = buildProductInfo(productUrl,
      [{ code: '6071620', name: 'A preorder book', soldByItself: false, variants: [{ code: '6071620', sku: '6071620', assets: [{ images: [{ uri: '/medias/book.jpg', format: 'largeImg' }] }] }] }],
      [{ price: { centAmount: 1800 } }], {});
    expect(product.requiresVariant).toBe(false);
    expect(product.imageUrl).toBe('https://www.bigw.com.au/medias/book.jpg');
  });

  it('requires a specific article when a parent has multiple unmatched variants', () => {
    const product = buildProductInfo(productUrl,
      [{ code: '6071620', name: 'A sized product', soldByItself: false, variants: [{ code: '6071621' }, { code: '6071622' }] }],
      [{ price: { centAmount: 1800 } }], {});
    expect(product.requiresVariant).toBe(true);
  });

  it('rejects malformed or non-cent cart totals', () => {
    expect(() => parseCartState({ id: 'CT_example', version: 1, entries: [], total: 22.5, deliveryCost: 4 })).toThrow();
    expect(() => parseCartState({ error: 'not a cart' })).toThrow();
  });
});
