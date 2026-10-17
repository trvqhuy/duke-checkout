import type { CartState, RunRequest } from './types.ts';
import { normalizeAustralianPhone, parseProductLink } from './validation.ts';
import { AppError } from '../server/errors.ts';

export function guardCart(cart: CartState, input: RunRequest): void {
  const code = parseProductLink(input.productUrl).code;
  if (cart.entries.length !== 1 || cart.entries[0].productCode !== code || cart.entries[0].quantity !== input.quantity) {
    throw new AppError('CART_CHANGED', 'The checkout cart does not exactly match this product and quantity. No payment was submitted.');
  }
  if (!Number.isSafeInteger(cart.total) || cart.total <= 0 || !Number.isSafeInteger(cart.version)) {
    throw new AppError('CART_INVALID', 'BIG W did not return a valid payable total and cart version.');
  }
  if (cart.total > input.maxTotalCents) throw new AppError('BUDGET', `The delivered total is $${(cart.total / 100).toFixed(2)}, above your $${(input.maxTotalCents / 100).toFixed(2)} limit. No payment was submitted.`);
  if (cart.validation?.isValid === false) throw new AppError('CART_INVALID', 'BIG W reports that this cart is not ready for checkout. Check availability in the BIG W tab.');
  if (!cart.deliveryAddress || !cart.billingAddress) throw new AppError('ADDRESS_REQUIRED', 'Delivery and billing details are not yet applied to the cart.');
  const normalize = (value: unknown) => String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/\bstreet\b/g, 'st').replace(/\broad\b/g, 'rd').replace(/\bavenue\b/g, 'ave')
    .replace(/\bdrive\b/g, 'dr').replace(/\bunit\b/g, 'u')
    .replace(/[^\p{L}\p{N}/-]+/gu, ' ').replace(/\s*([/-])\s*/g, '$1').replace(/\s+/g, ' ').trim();
  for (const [actual, expected] of [[cart.deliveryAddress, input.profile.deliveryAddress], [cart.billingAddress, input.profile.billingSame ? input.profile.deliveryAddress : input.profile.billingAddress!]] as const) {
    if (['line1', 'line2', 'suburb', 'postcode', 'state'].some(key => normalize(actual[key]) !== normalize(expected[key as keyof typeof expected]))) {
      throw new AppError('ADDRESS_CHANGED', 'The native checkout changed the delivery or billing address. Check the selected profile and BIG W checkout before purchasing.');
    }
  }
  const contacts = [cart.customer, cart.deliveryAddress].filter(Boolean) as Record<string, unknown>[];
  for (const key of ['firstName', 'lastName'] as const) {
    const values = contacts.map(contact => contact[key]).filter(value => value !== undefined && value !== null);
    if (!values.length || values.some(value => normalize(value) !== normalize(input.profile[key]))) {
      throw new AppError('CONTACT_CHANGED', 'The checkout recipient no longer matches the selected contact profile. No payment was submitted.');
    }
  }
  const phones = contacts.flatMap(contact => [contact.phone, contact.phonenumber]).filter(value => value !== undefined && value !== null && value !== '');
  if (!phones.length || phones.some(phone => normalizeAustralianPhone(phone) !== input.profile.phone)) {
    throw new AppError('CONTACT_CHANGED', 'The checkout delivery phone no longer matches the selected contact profile. No payment was submitted.');
  }
}
