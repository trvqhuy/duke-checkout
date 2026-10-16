import { describe, expect, it } from 'vitest';
import { parseProductLink, validateCard, validateProfile, validateRun } from '../src/shared/validation.ts';
import { productUrl, profile, runInput, testCard } from './fixtures.ts';

describe('checkout inputs', () => {
  it('canonicalizes a BIG W product link without retaining tracking data', () => {
    expect(parseProductLink(productUrl + '?tracking=example#details')).toEqual({ url: productUrl, code: '6071620' });
  });

  it.each([
    'https://bigw.com.au.attacker.example/product/book/p/6071620',
    'https://www.bigw.com.au/cart',
    'http://www.bigw.com.au/product/book/p/6071620',
    'https://user:password@www.bigw.com.au/product/book/p/6071620',
  ])('rejects an unsupported link: %s', value => {
    expect(() => parseProductLink(value)).toThrow();
  });

  it('normalizes an Australian phone before checkout', () => {
    expect(validateProfile(profile).phone).toBe('+61412345678');
    expect(validateProfile({ ...profile, phone: '+61 412 345 678' }).phone).toBe('+61412345678');
  });

  it('rejects an international delivery phone', () => {
    expect(() => validateProfile({ ...profile, phone: '+84851234567' })).toThrow();
  });

  it('rejects payment fields in a contact profile', () => {
    expect(() => validateProfile({ ...profile, cardNumber: testCard.number })).toThrow();
  });

  it('requires a complete separate billing address when selected', () => {
    expect(() => validateProfile({ ...profile, billingSame: false })).toThrow();
  });

  it('prepares without a payment method and converts the budget to cents', () => {
    const result = validateRun(runInput);
    expect(result.maxTotalCents).toBe(2500);
    expect(result.card).toBeUndefined();
  });

  it.each([{ quantity: 1.5 }, { quantity: 0 }, { quantity: 21 }, { maxTotal: '0' }, { maxTotal: '1.001' }])('rejects invalid run controls %j', patch => {
    expect(() => validateRun({ ...runInput, ...patch })).toThrow();
  });

  it('requires card information before fill-only or automatic purchase begins', () => {
    expect(() => validateRun({ ...runInput, mode: 'assist' })).toThrow();
    expect(() => validateRun({ ...runInput, mode: 'purchase' })).toThrow();
    expect(validateRun({ ...runInput, mode: 'assist', card: testCard }).card?.kind).toBe('new');
    expect(validateRun({ ...runInput, mode: 'purchase', card: testCard }).card?.kind).toBe('new');
  });

  it('allows the Afterpay mode without a card', () => {
    const result = validateRun({ ...runInput, mode: 'afterpay' });
    expect(result.mode).toBe('afterpay');
    expect(result.card).toBeUndefined();
  });

  it('checks card checksum, expiry, and CVV without retaining formatting', () => {
    expect(validateCard({ ...testCard, number: '4111 1111 1111 1111' })).toEqual(testCard);
    expect(() => validateCard({ ...testCard, number: '4111111111111112' })).toThrow();
    expect(() => validateCard({ ...testCard, expiry: '01/20' })).toThrow();
    expect(() => validateCard({ ...testCard, cvv: '12' })).toThrow();
  });
});
