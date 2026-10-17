// Pure payment-request guard logic shared by the server-side PaymentGuard
// (src/server/browser/payment-guard.ts) and the MAIN-world extension guard
// (src/extension/content/api-bridge-main.ts). Behaviour is identical in both
// worlds; the server file imports and re-exports these symbols so its tests
// keep passing unchanged.

// Verbatim copy of `record` from src/server/browser/bigw-model.ts. Inlined
// rather than imported: bigw-model's module-level `z.object(...)` initializers
// pull zod AND libphonenumber-js (via validation.ts) into the extension's
// injected content bundle (measured at ~660 KB) because esbuild cannot drop
// side-effectful module initializers. This shared module must stay pure.
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface PaymentBinding {
  cartId: string;
  cartVersion: number;
  totalCents: number;
  kind: 'new' | 'saved';
  sessionId?: string;
  savedCardId?: string;
  securityCode?: string;
}

export function financialUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (!['https://api.bigw.com.au', 'https://apix.bigw.com.au', 'https://www.bigw.com.au'].includes(url.origin)) return;
    const path = decodeURIComponent(url.pathname);
    if (/(?:^|\/)(?:pay|capturePayment|paymentApproved|authorization)(?:\/|$)|\/payment-options\/[^/]+\/complete(?:-saved)?$/i.test(path)) return url;
  } catch { return; }
}

export function empty(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === '' || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(record(value)).length === 0;
}

export function checkPaymentRequest(value: string, rawBody: string | undefined, binding: PaymentBinding): string | null {
  let url: URL, body: Record<string, unknown>;
  try {
    url = new URL(value);
    if (!rawBody || rawBody.length > 32_768) return 'PAYMENT_CHANGED';
    body = record(JSON.parse(rawBody));
  } catch { return 'PAYMENT_CHANGED'; }
  const root = `/storefront/v1/cart/${binding.cartId}/pay`;
  if (url.origin !== 'https://api.bigw.com.au' || ![root, `${root}/finalize`].includes(decodeURIComponent(url.pathname)) || body.cartId !== binding.cartId) return 'CART_CHANGED';
  if (url.pathname.endsWith('/finalize')) {
    if (body.amountInCents !== undefined && body.amountInCents !== binding.totalCents) return 'PAYMENT_CHANGED';
    return null;
  }
  if (body.cartVersion !== binding.cartVersion) return 'CART_CHANGED';
  if (Object.keys(body).some(key => !['cartId', 'cartVersion', 'deviceFingerprint', 'transactions'].includes(key))) return 'PAYMENT_CHANGED';
  const transactions = record(body.transactions);
  const key = binding.kind === 'new' ? 'creditCardPaymentInfo' : 'creditCardPaymentStoredInfo';
  const payment = record(transactions[key]);
  if (Object.entries(transactions).some(([name, data]) => name !== key && !empty(data))) return 'PAYMENT_CHANGED';
  if (payment.amountInCents !== binding.totalCents) return 'PAYMENT_CHANGED';
  if (binding.kind === 'new') {
    if (!binding.sessionId || payment.sessionId !== binding.sessionId || Object.keys(payment).some(name => !['amountInCents', 'sessionId', 'storePaymentMethod'].includes(name))) return 'PAYMENT_CHANGED';
  } else if (payment.internalPaymentMethodId !== binding.savedCardId || payment.securityCode !== binding.securityCode || Object.keys(payment).some(name => !['amountInCents', 'internalPaymentMethodId', 'securityCode'].includes(name))) return 'PAYMENT_CHANGED';
  return null;
}
