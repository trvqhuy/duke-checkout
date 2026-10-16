import type { ArmedCheckout, RunRequest } from './types.ts';

// True when an armed checkout can serve this run as-is: same product link,
// quantity, and contact/delivery profile, and the run's budget still covers the
// armed cart (guardCart re-checks the live total at run time regardless).
export function armedMatches(armed: ArmedCheckout, input: RunRequest): boolean {
  const left = armed.profile;
  const right = input.profile;
  const profileSame = left.name === right.name && left.firstName === right.firstName && left.lastName === right.lastName
    && left.phone === right.phone && left.billingSame === right.billingSame
    && JSON.stringify(left.deliveryAddress) === JSON.stringify(right.deliveryAddress)
    && JSON.stringify(left.billingAddress ?? null) === JSON.stringify(right.billingAddress ?? null);
  return armed.productUrl === input.productUrl && armed.quantity === input.quantity && profileSame;
}
