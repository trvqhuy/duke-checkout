import { EventEmitter } from 'node:events';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { describe, expect, it } from 'vitest';
import { checkPaymentRequest, PaymentGuard, type PaymentBinding } from '../src/server/browser/payment-guard.ts';

const binding: PaymentBinding = { cartId: 'CT_example', cartVersion: 4, totalCents: 2200, kind: 'new', sessionId: 'current-session' };
const url = 'https://api.bigw.com.au/storefront/v1/cart/CT_example/pay';
const payload = () => ({ cartId: 'CT_example', cartVersion: 4, transactions: { creditCardPaymentInfo: { amountInCents: 2200, sessionId: 'current-session' } } });

describe('outgoing payment binding', () => {
  it('permits the verified cart, version, amount, and secure-fields session', () => {
    expect(checkPaymentRequest(url, JSON.stringify(payload()), binding)).toBeNull();
  });

  it('rejects changed amounts, versions, sessions, and other carts', () => {
    expect(checkPaymentRequest(url, JSON.stringify({ ...payload(), cartVersion: 5 }), binding)).toBeTruthy();
    expect(checkPaymentRequest(url, JSON.stringify({ ...payload(), transactions: { creditCardPaymentInfo: { amountInCents: 9000, sessionId: 'current-session' } } }), binding)).toBeTruthy();
    expect(checkPaymentRequest(url, JSON.stringify({ ...payload(), transactions: { creditCardPaymentInfo: { amountInCents: 2200, sessionId: 'old-session' } } }), binding)).toBeTruthy();
    expect(checkPaymentRequest(url.replace('CT_example', 'CT_other'), JSON.stringify(payload()), binding)).toBeTruthy();
  });

  it('rejects additional non-empty payment instruments', () => {
    expect(checkPaymentRequest(url, JSON.stringify({ ...payload(), transactions: { ...payload().transactions, giftCardPaymentInfo: [{ amountInCents: 400 }] } }), binding)).toBeTruthy();
  });

  it('aborts mismatches before continuing a request', async () => {
    const page = Object.assign(new EventEmitter(), { setRequestInterception: async () => {} });
    let aborted = false, continued = false, prevented = false;
    const gate = new PaymentGuard(page as unknown as Page, binding, { onSent: () => {}, onPrevented: () => { prevented = true; }, onUncertain: () => {} });
    await gate.enable();
    const request = { url: () => url, method: () => 'POST', postData: () => JSON.stringify({ ...payload(), cartVersion: 5 }), isInterceptResolutionHandled: () => false, abort: async () => { aborted = true; }, continue: async () => { continued = true; } } as unknown as HTTPRequest;
    await Promise.all(page.listeners('request').map(listener => listener(request)));
    expect(aborted).toBe(true); expect(continued).toBe(false); expect(prevented).toBe(true);
    gate.close(); await gate.releaseAfterNavigation();
  });

  it('blocks a duplicate submission while the attempt is active', async () => {
    const page = Object.assign(new EventEmitter(), { setRequestInterception: async () => {} });
    let sends = 0, aborts = 0;
    const gate = new PaymentGuard(page as unknown as Page, binding, { onSent: () => {}, onPrevented: () => {}, onUncertain: () => {} });
    await gate.enable();
    const request = () => ({ url: () => url, method: () => 'POST', postData: () => JSON.stringify(payload()), isInterceptResolutionHandled: () => false, abort: async () => { aborts++; }, continue: async () => { sends++; } }) as unknown as HTTPRequest;
    for (let index = 0; index < 2; index++) await Promise.all(page.listeners('request').map(listener => listener(request())));
    expect(sends).toBe(1); expect(aborts).toBe(1);
    gate.close(); await gate.releaseAfterNavigation();
  });

  it('releases financial requests to the page after the attempt settles', async () => {
    const page = Object.assign(new EventEmitter(), { setRequestInterception: async () => {} });
    let sends = 0, aborts = 0;
    const gate = new PaymentGuard(page as unknown as Page, binding, { onSent: () => {}, onPrevented: () => {}, onUncertain: () => {} });
    await gate.enable();
    gate.close();
    const request = () => ({ url: () => url, method: () => 'POST', postData: () => JSON.stringify(payload()), isInterceptResolutionHandled: () => false, abort: async () => { aborts++; }, continue: async () => { sends++; } }) as unknown as HTTPRequest;
    await Promise.all(page.listeners('request').map(listener => listener(request())));
    expect(sends).toBe(1); expect(aborts).toBe(0);
    await gate.releaseAfterNavigation();
  });
});
