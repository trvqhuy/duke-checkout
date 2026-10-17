import type { HTTPRequest, Page } from 'puppeteer-core';
import { AppError } from '../errors.ts';
import { checkPaymentRequest, financialUrl } from '../../shared/payment-check.ts';
import type { PaymentBinding } from '../../shared/payment-check.ts';

export { checkPaymentRequest, financialUrl, empty } from '../../shared/payment-check.ts';
export type { PaymentBinding } from '../../shared/payment-check.ts';

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
