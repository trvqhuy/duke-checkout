import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';
import type { PaymentInput, Profile, RunMode, RunRequest } from './types.ts';

// Modes that pause for the user with a card: fill-only (assist) and a real
// payment (purchase). prepare and afterpay submit nothing, so they need none.
// Defined once here so the trigger policy and the app form cannot drift.
export function modeNeedsCard(mode: RunMode): boolean {
  return mode === 'assist' || mode === 'purchase';
}

export function parseProductLink(value: string): { url: string; code: string } {
  const url = new URL(value.trim());
  const match = url.pathname.match(/^\/product\/[^/]+\/p\/(\d{3,12})\/?$/);
  if (url.protocol !== 'https:' || !['www.bigw.com.au', 'bigw.com.au'].includes(url.hostname)
    || url.username || url.password || url.port || !match) {
    throw new Error('Use a secure BIG W product link ending in /p/article-number.');
  }
  return { url: `https://www.bigw.com.au${url.pathname.replace(/\/$/, '')}`, code: match[1] };
}

const text = (label: string, max = 100) => z.string().trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);
export function normalizeAustralianPhone(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const number = parsePhoneNumberFromString(value, 'AU');
  return number?.country === 'AU' && number.isValid() ? number.number : undefined;
}
const addressSchema = z.object({
  line1: text('Street address', 150),
  line2: z.string().trim().max(100).default(''),
  suburb: text('Suburb', 80),
  postcode: z.string().trim().regex(/^\d{4}$/, 'Enter a four-digit Australian postcode.'),
  state: z.enum(['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'], { error: 'Select an Australian state.' }),
  country: z.literal('AU').default('AU'),
}).strict();

const profileSchema = z.object({
  id: z.string().uuid().optional(),
  name: text('Profile name', 60),
  firstName: text('First name', 60),
  lastName: text('Last name', 60),
  phone: z.string().trim().transform((value, context) => {
    const number = normalizeAustralianPhone(value);
    if (!number) {
      context.addIssue({ code: 'custom', message: 'Enter a valid Australian delivery phone number.' });
      return z.NEVER;
    }
    return number;
  }),
  deliveryAddress: addressSchema,
  billingSame: z.boolean(),
  billingAddress: addressSchema.optional(),
}).strict().superRefine((profile, context) => {
  if (!profile.billingSame && !profile.billingAddress) {
    context.addIssue({ code: 'custom', path: ['billingAddress'], message: 'Enter the billing address or use the delivery address.' });
  }
});

export function validateProfile(value: unknown): Profile {
  return profileSchema.parse(value);
}

function luhn(value: string): boolean {
  let total = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index--) {
    let digit = Number(value[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    total += digit;
    double = !double;
  }
  return total % 10 === 0;
}

const cvvSchema = z.string().trim().regex(/^\d{3,4}$/, 'Enter a three- or four-digit security code.');
const paymentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new'),
    number: z.string().transform(value => value.replace(/[\s-]/g, '')).refine(value => /^\d{12,19}$/.test(value) && luhn(value), 'This card number looks invalid (checksum failed). Check for a typo.'),
    expiry: z.string().trim().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, 'Use MM/YY for the expiry date.').refine(value => {
      const [month, year] = value.split('/').map(Number);
      return Date.UTC(2000 + year, month, 1) > Date.now();
    }, 'This card has expired.'),
    cvv: cvvSchema,
  }).strict(),
  z.object({ kind: z.literal('saved'), cardId: z.string().min(8).max(120).regex(/^[\w-]+$/), cvv: cvvSchema }).strict(),
]);

export function validateCard(value: unknown): PaymentInput {
  return paymentSchema.parse(value);
}

const runSchema = z.object({
  requestId: z.string().uuid().optional(),
  productUrl: z.string().trim().transform((value, context) => {
    try { return parseProductLink(value).url; }
    catch { context.addIssue({ code: 'custom', message: 'Use a BIG W product link ending in /p/article-number.' }); return z.NEVER; }
  }),
  quantity: z.number().int('Quantity must be a whole number.').min(1).max(20),
  maxTotal: z.union([z.string(), z.number()]).transform(String).refine(value => /^\d{1,5}(?:\.\d{1,2})?$/.test(value) && Number(value) > 0 && Number(value) <= 50_000, 'Enter a delivered budget between $0.01 and $50,000, with at most two decimal places.').transform(value => Math.round(Number(value) * 100)),
  mode: z.enum(['prepare', 'assist', 'purchase', 'afterpay']),
  profile: profileSchema,
  card: paymentSchema.optional(),
}).strict().superRefine((input, context) => {
  if ((input.mode === 'assist' || input.mode === 'purchase') && !input.card) {
    context.addIssue({ code: 'custom', path: ['card'], message: 'Enter a payment method for this mode.' });
  }
});

export function validateRun(value: unknown): RunRequest {
  const { maxTotal, ...input } = runSchema.parse(value);
  return { ...input, maxTotalCents: maxTotal };
}
