import { EventEmitter } from 'node:events';
import type { Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';
import { interpretPaymentResult, isPaymentEndpoint, isVaultEndpoint, PaymentDriver } from '../src/server/browser/payment.ts';
import { productUrl, testCard } from './fixtures.ts';

describe('merchant payment evidence', () => {
  it('requires a successful merchant response with an order reference', () => {
    expect(interpretPaymentResult({ orderNumber: 'BW-10001' }, 200)).toEqual({ status: 'confirmed', orderNumber: 'BW-10001' });
    expect(interpretPaymentResult({ paymentId: 'payment-only', status: 'APPROVED' }, 200)).toBeNull();
    expect(interpretPaymentResult({ orderNumber: 'BW-10001' }, 500)).toBeNull();
    expect(interpretPaymentResult({ orderNumber: 'BW-10001', approvalUrl: 'https://payments.example/challenge' }, 200)).toBeNull();
    expect(interpretPaymentResult({ orderId: 'draft-only' }, 200)).toBeNull();
  });

  it('recognizes an explicit rejection without echoing processor details', () => {
    expect(interpretPaymentResult({ code: 'CARD_DECLINED', message: 'private processor details' }, 400)?.status).toBe('declined');
    expect(interpretPaymentResult({ message: 'network failed' }, 502)).toBeNull();
    expect(interpretPaymentResult({ orderNumber: 'BW-10001', code: 'CARD_DECLINED' }, 200)?.status).toBe('declined');
  });

  it('treats BIG W errorCode rejections and other client errors as definite failures', () => {
    expect(interpretPaymentResult({ errorCode: 'INVALID_PAYMENT', details: null }, 409)?.status).toBe('declined');
    expect(interpretPaymentResult({ errorCode: 'INSUFFICIENT_FUNDS' }, 402)?.status).toBe('declined');
    expect(interpretPaymentResult({}, 409)?.status).toBe('declined');
    expect(interpretPaymentResult({}, 422)?.status).toBe('declined');
  });

  it('only observes payment requests for the current cart on the merchant origin', () => {
    expect(isPaymentEndpoint('https://api.bigw.com.au/storefront/v1/cart/CT_example/pay', 'CT_example')).toBe(true);
    expect(isPaymentEndpoint('https://api.bigw.com.au/storefront/v1/cart/CT_example/pay/finalize', 'CT_example')).toBe(true);
    expect(isPaymentEndpoint('https://api.bigw.com.au/storefront/v1/cart/CT_other/pay', 'CT_example')).toBe(false);
    expect(isPaymentEndpoint('https://other.example/storefront/v1/cart/CT_example/pay', 'CT_example')).toBe(false);
  });

  it('recognizes the card tokenization endpoint', () => {
    expect(isVaultEndpoint('https://api.wpay2.gr4vy.app/checkout/sessions/abc-123/card-details')).toBe(true);
    expect(isVaultEndpoint('https://api.wpay2.gr4vy.app/checkout/sessions/abc-123/fields')).toBe(false);
    expect(isVaultEndpoint('https://other.example/checkout/sessions/abc/card-details')).toBe(false);
  });

  it('does not treat a stale vault-error banner as the current attempt failing', async () => {
    vi.useFakeTimers();
    const owner = new EventEmitter();
    const locator = { setTimeout: () => locator, click: async () => {} };
    const page = Object.assign(new EventEmitter(), {
      locator: () => locator,
      frames: () => [{ url: () => 'https://secure-fields.wpay2.gr4vy.app/input.html?type=number&sessionId=current-session' }],
      setRequestInterception: async () => {}, browser: () => owner,
      evaluate: async (script: string) => script.includes('challenge')
        ? { url: 'https://www.bigw.com.au/checkout/delivery', challenge: false, confirmed: false, vaultFailed: true } : true,
    });
    const driver = new PaymentDriver(page as unknown as Page, async () => ({}));
    let settled = false;
    try {
      const result = driver.submit({ cartId: 'CT_example', cart: { id: 'CT_example', version: 4, entries: [{ productCode: '6071620', quantity: 1 }], total: 2200, deliveryCost: 400 }, product: { code: '6071620', url: productUrl, title: 'A book', priceCents: 1800, deliveryCents: 400, available: true, stockLabel: 'Pre-order' } }, testCard, () => {});
      void result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(800);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(300_000);
      expect((await result).status).toBe('unknown');
    } finally { await driver.resetAfterNavigation?.(); vi.useRealTimers(); }
  });

  it('ignores a response that did not belong to a request approved for this attempt', async () => {
    vi.useFakeTimers();
    const owner = new EventEmitter();
    const orphan = { method: () => 'POST' };
    const page = Object.assign(new EventEmitter(), {
      frames: () => [{ url: () => 'https://secure-fields.wpay2.gr4vy.app/input.html?type=number&sessionId=current-session' }],
      setRequestInterception: async () => {}, browser: () => owner,
      evaluate: async () => ({ url: 'https://www.bigw.com.au/checkout/delivery', challenge: false, confirmed: false }),
      locator: () => ({ setTimeout() { return this; }, async click() {
        page.emit('response', { url: () => 'https://api.bigw.com.au/storefront/v1/cart/CT_example/pay', request: () => orphan, status: () => 200, json: async () => ({ orderNumber: 'BW-OLD-RESPONSE' }) });
      } }),
    });
    const driver = new PaymentDriver(page as unknown as Page, async () => ({}));
    let settled = false;
    try {
      const result = driver.submit({ cartId: 'CT_example', cart: { id: 'CT_example', version: 4, entries: [{ productCode: '6071620', quantity: 1 }], total: 2200, deliveryCost: 400 }, product: { code: '6071620', url: productUrl, title: 'A book', priceCents: 1800, deliveryCents: 400, available: true, stockLabel: 'Pre-order' } }, testCard, () => {});
      void result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(800);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(300_000);
      expect((await result).status).toBe('unknown');
    } finally { await driver.resetAfterNavigation(); vi.useRealTimers(); }
  });
});
