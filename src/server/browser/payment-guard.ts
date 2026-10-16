import type { HTTPRequest, Page } from 'puppeteer-core';
import { AppError } from '../errors.ts';
import { record } from './bigw-model.ts';

export interface PaymentBinding {
  cartId: string;
  cartVersion: number;
  totalCents: number;
  kind: 'new' | 'saved';
  sessionId?: string;
  savedCardId?: string;
  securityCode?: string;
}

function financialUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (!['https://api.bigw.com.au', 'https://apix.bigw.com.au', 'https://www.bigw.com.au'].includes(url.origin)) return;
    const path = decodeURIComponent(url.pathname);
    if (/(?:^|\/)(?:pay|capturePayment|paymentApproved|authorization)(?:\/|$)|\/payment-options\/[^/]+\/complete(?:-saved)?$/i.test(path)) return url;
  } catch { return; }
}

function empty(value: unknown): boolean {
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

interface Callbacks { onSent(): void; onPrevented(code: string): void; onUncertain(): void }

export class PaymentGuard {
  private binding?: PaymentBinding;
  private callbacks?: Callbacks;
  private closed = false;
  private sent = false;
  private finalized = false;
  private released = false;
  private blocked = new WeakSet<HTTPRequest>();
  private allowed = new WeakSet<HTTPRequest>();
  private readonly handler = (request: HTTPRequest) => this.handle(request).catch(() => { if (!this.closed) this.callbacks?.onUncertain(); });
  private readonly navigated = () => { if (this.closed) void this.releaseAfterNavigation().catch(() => undefined); };

  constructor(private page: Page, binding: PaymentBinding, callbacks: Callbacks) {
    this.binding = { ...binding }; this.callbacks = callbacks;
  }

  wasBlocked(request: HTTPRequest): boolean { return this.blocked.has(request); }
  wasAllowed(request: HTTPRequest): boolean { return this.allowed.has(request); }

  async enable(): Promise<void> {
    this.page.on('request', this.handler);
    this.page.on('domcontentloaded', this.navigated);
    await this.page.setRequestInterception(true);
  }

  private async handle(request: HTTPRequest): Promise<void> {
    const financial = request.method() === 'POST' && !!financialUrl(request.url());
    if (request.isInterceptResolutionHandled()) { if (financial && !this.closed) this.callbacks?.onUncertain(); return; }
    // Once the attempt settles the guard stops making decisions: it releases the
    // page to whatever the user or the site does next (for example a manual
    // payment). Duplicate automated submissions are prevented by the product
    // lock for unknown outcomes and by the single-click/one-request drive.
    if (this.closed) { await request.continue({}, -100).catch(() => undefined); return; }
    if (!financial) { await request.continue({}, -100).catch(() => undefined); return; }
    const finalizer = new URL(request.url()).pathname.endsWith('/finalize');
    const duplicate = finalizer ? !this.sent || this.finalized : this.sent;
    const violation = this.binding ? checkPaymentRequest(request.url(), request.postData(), this.binding) : 'PAYMENT_CLOSED';
    if (duplicate || violation) {
      this.blocked.add(request);
      await request.abort('blockedbyclient', 100);
      if (!this.sent) this.callbacks?.onPrevented(violation ?? 'PAYMENT_DUPLICATE');
      return;
    }
    if (finalizer) this.finalized = true;
    else { this.sent = true; this.callbacks?.onSent(); }
    this.allowed.add(request);
    await request.continue({}, -100);
  }

  close(): void {
    this.closed = true;
    // Keep only the closed request fence alive: no CVV, session, or callbacks.
    this.binding = undefined; this.callbacks = undefined;
  }

  async releaseAfterNavigation(): Promise<void> {
    if (this.released) return;
    if (!this.closed) throw new AppError('PAYMENT_BUSY', 'Payment is still in progress. Its request guard cannot be removed.');
    this.released = true;
    // Only remove this guard's listener. Request interception itself is owned by
    // the persistent traffic policy (which blocks third-party hosts and continues
    // everything else), so it must stay enabled after the payment settles.
    this.page.off('request', this.handler); this.page.off('domcontentloaded', this.navigated);
  }
}
