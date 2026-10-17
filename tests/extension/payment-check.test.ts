import { describe, expect, it } from 'vitest';
import { checkPaymentRequest, empty, financialUrl, type PaymentBinding } from '../../src/shared/payment-check.ts';

const binding: PaymentBinding = { cartId: 'CT_example', cartVersion: 4, totalCents: 2200, kind: 'new', sessionId: 'current-session' };
const url = 'https://api.bigw.com.au/storefront/v1/cart/CT_example/pay';
const payload = () => ({ cartId: 'CT_example', cartVersion: 4, transactions: { creditCardPaymentInfo: { amountInCents: 2200, sessionId: 'current-session' } } });

describe('shared payment-request check', () => {
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

  it('finalize only checks the optional amount', () => {
    const finalize = `${url}/finalize`;
    expect(checkPaymentRequest(finalize, JSON.stringify({ cartId: 'CT_example' }), binding)).toBeNull();
    expect(checkPaymentRequest(finalize, JSON.stringify({ cartId: 'CT_example', amountInCents: 2200 }), binding)).toBeNull();
    expect(checkPaymentRequest(finalize, JSON.stringify({ cartId: 'CT_example', amountInCents: 9000 }), binding)).toBe('PAYMENT_CHANGED');
  });

  it('rejects missing, malformed, and oversized bodies as PAYMENT_CHANGED', () => {
    expect(checkPaymentRequest(url, undefined, binding)).toBe('PAYMENT_CHANGED');
    expect(checkPaymentRequest(url, '{not json', binding)).toBe('PAYMENT_CHANGED');
    expect(checkPaymentRequest(url, `{"cartId":"CT_example","pad":"${'x'.repeat(32_769)}"}`, binding)).toBe('PAYMENT_CHANGED');
  });

  it('rejects unexpected top-level keys and a wrong cart id', () => {
    expect(checkPaymentRequest(url, JSON.stringify({ ...payload(), extra: 1 }), binding)).toBe('PAYMENT_CHANGED');
    expect(checkPaymentRequest(url, JSON.stringify({ ...payload(), cartId: 'CT_other' }), binding)).toBe('CART_CHANGED');
  });

  it('checks saved-card bindings', () => {
    const saved: PaymentBinding = { cartId: 'CT_example', cartVersion: 4, totalCents: 2200, kind: 'saved', savedCardId: 'card-1', securityCode: '123' };
    const body = JSON.stringify({ cartId: 'CT_example', cartVersion: 4, transactions: { creditCardPaymentStoredInfo: { amountInCents: 2200, internalPaymentMethodId: 'card-1', securityCode: '123' } } });
    expect(checkPaymentRequest(url, body, saved)).toBeNull();
    expect(checkPaymentRequest(url, body.replace('card-1', 'card-2'), saved)).toBe('PAYMENT_CHANGED');
  });

  it('financialUrl recognizes payment paths and empty recognizes empties', () => {
    expect(financialUrl(url)?.href).toBe(url);
    expect(financialUrl('https://evil.example/pay')).toBeUndefined();
    expect(financialUrl('not-a-url')).toBeUndefined();
    expect(empty({})).toBe(true);
    expect(empty([])).toBe(true);
    expect(empty({ a: 1 })).toBe(false);
  });
});
