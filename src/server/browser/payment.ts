import type { Frame, HTTPRequest, HTTPResponse, Page } from 'puppeteer-core';
import type { PaymentInput, PaymentOutcome, PreparedCheckout } from '../../shared/types.ts';
import { AppError, checkAbort } from '../errors.ts';
import { record, string } from './bigw-model.ts';
import { PaymentGuard, type PaymentBinding } from './payment-guard.ts';

const SECURE_ORIGIN = 'https://secure-fields.wpay2.gr4vy.app';
const READY = `!!document.querySelector('iframe[src*="secure-fields.wpay2.gr4vy.app/input.html"], #saved-cards--nextgen')`;

export function isPaymentEndpoint(url: string, cartId: string): boolean {
  try {
    const value = new URL(url);
    return value.origin === 'https://api.bigw.com.au' && [
      `/storefront/v1/cart/${cartId}/pay`, `/storefront/v1/cart/${cartId}/pay/finalize`,
    ].includes(decodeURIComponent(value.pathname));
  } catch { return false; }
}

// Gr4vy tokenizes the card before BIG W's payment call. A failure here (including
// an expired checkout session) means BIG W never receives a payment.
export function isVaultEndpoint(url: string): boolean {
  try {
    const value = new URL(url);
    return value.origin === 'https://api.wpay2.gr4vy.app' && /^\/checkout\/sessions\/[^/]+\/card-details$/.test(value.pathname);
  } catch { return false; }
}

function orderReference(body: Record<string, unknown>): string | undefined {
  const value = body.orderNumber;
  return (typeof value === 'string' || typeof value === 'number') && /^[\w-]{3,80}$/.test(String(value)) ? String(value) : undefined;
}

const DECLINED_CODES = ['CARD_DECLINED', 'PAYMENT_DECLINED', 'DECLINED', 'INSUFFICIENT_FUNDS', 'INVALID_PAYMENT', 'INVALID_CARD', 'CARD_EXPIRED', 'PROCESSOR_DECLINED', 'FRAUD', 'FRAUD_DECLINED'];

export function interpretPaymentResult(value: unknown, status: number): PaymentOutcome | null {
  const outer = record(value), body = record(outer.data ?? value);
  const code = string(body.errorCode, string(body.code, string(body.status, string(record(body.error).code)))).toUpperCase();
  if (DECLINED_CODES.includes(code)) {
    return { status: 'declined', message: 'BIG W rejected the payment. Check the card details and try again, or use another card.' };
  }
  if (body.approvalUrl || ['PENDING', 'PROCESSING', 'AUTHENTICATION_REQUIRED', 'REQUIRES_ACTION'].includes(code)) return null;
  const reference = orderReference(body);
  if (status >= 200 && status < 300 && reference) return { status: 'confirmed', orderNumber: reference };
  // Any other client-error response means BIG W did not accept the payment.
  if (status >= 400 && status < 500) {
    return { status: 'declined', message: 'BIG W rejected the payment. Check the card details and try again, or use another card.' };
  }
  return null;
}

export class PaymentDriver {
  private filled = false;
  private gate?: PaymentGuard;
  constructor(private page: Page, private request: (path: string, method?: string, body?: unknown) => Promise<unknown>) {}

  // evaluate()-based polling so a navigation (which destroys waitForFunction) does
  // not fail an otherwise-good wait. Returns true if the condition was observed.
  private async waitForCondition(condition: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastLog = 0;
    while (Date.now() < deadline) {
      if (signal) checkAbort(signal);
      try {
        if (await this.page.evaluate(condition)) return true;
      } catch { /* navigation; retry */ }
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        let url = '?';
        try { url = this.page.url(); } catch { /* ignore */ }
        console.log(`[duke] wait ${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s on ${url.slice(0, 70)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }

  async ready(signal: AbortSignal): Promise<void> {
    const condition = `${READY} || Array.from(document.querySelectorAll('button')).some(b => /Continue to Payment/i.test(b.textContent || ''))`;
    const deadline = Date.now() + 60_000;
    let lastRecover = Date.now();
    while (Date.now() < deadline) {
      checkAbort(signal);
      try {
        if (await this.page.evaluate(condition)) break;
      } catch { /* navigation; retry */ }
      // If the working tab has drifted off the checkout (for example a stray
      // navigation left it on the preparation document), reopen the checkout.
      try {
        const url = this.page.url();
        if (!/\/checkout\//.test(url) && Date.now() - lastRecover > 6_000) {
          lastRecover = Date.now();
          console.log(`[duke] ready: tab drifted to ${url.slice(0, 60)}; reopening checkout`);
          await this.page.goto('https://www.bigw.com.au/checkout/delivery', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
        }
      } catch { /* page busy; retry */ }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!(await this.page.evaluate(condition).catch(() => false))) {
      throw new AppError('PAYMENT_NOT_READY', 'BIG W’s payment form did not become ready. Check the checkout tab for a sign-in or address requirement.');
    }
    checkAbort(signal);
    if (await this.waitForCondition(READY, 1_000, signal)) return;
    // The contact step is showing: press Continue, tolerating navigation too.
    const continueDeadline = Date.now() + 30_000;
    while (Date.now() < continueDeadline) {
      checkAbort(signal);
      try { await this.page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(node => /Continue to Payment/i.test(node.textContent || '')); if (b && !b.disabled) b.click(); })()`); } catch { /* navigation; retry */ }
      if (await this.waitForCondition(READY, 1_500, signal)) return;
    }
    throw new AppError('CONTACT_REQUIRED', 'BIG W needs contact or address details corrected in the checkout tab. Check the selected profile.');
  }

  private frame(type: string): Frame | undefined {
    return this.page.frames().find(frame => this.isSecureFrame(frame, type));
  }

  private isSecureFrame(frame: Frame, type: string): boolean {
    try {
      const url = new URL(frame.url());
      return url.origin === SECURE_ORIGIN && url.pathname === '/input.html' && url.searchParams.get('type') === type;
    } catch { return false; }
  }

  // The secure iframes appear in the DOM slightly before Puppeteer's frame tree
  // registers them, so a plain frames() lookup can miss one and fail instantly.
  private async waitFrame(type: string, timeout: number): Promise<Frame | undefined> {
    const existing = this.frame(type);
    if (existing) return existing;
    try { return await this.page.waitForFrame(frame => this.isSecureFrame(frame, type), { timeout }); }
    catch { return this.frame(type); }
  }

  private async readField(type: string): Promise<string | undefined> {
    const frame = this.frame(type);
    if (!frame) return undefined;
    try { return await frame.$eval('input:not([type="hidden"])', element => (element as HTMLInputElement).value); }
    catch { return undefined; }
  }

  async fill(card: PaymentInput, opts?: { programmaticSubmit?: boolean }): Promise<void> {
    if (card.kind === 'saved') {
      const cards = await this.request('/storefront/v1/cart/saved-cards');
      if (!Array.isArray(cards) || !cards.some(item => record(item).id === card.cardId)) throw new AppError('SAVED_CARD', 'This saved card is no longer available. Import the current BIG W details again.');
      return;
    }
    // Secure-field locators need an active renderer for stable layout/focus.
    // The API-only preparation can stay in the background; card entry cannot.
    await this.page.bringToFront();
    const fields: [string, string][] = [['number', card.number], ['expiryDate', card.expiry], ['securityCode', card.cvv]];
    const normalize = (value?: string) => (value ?? '').replace(/\D/g, '');
    const describeFrames = () => this.page.frames().map(frame => { try { const url = new URL(frame.url()); return `${url.host}${url.pathname}${url.searchParams.get('type') ? '?' + url.searchParams.get('type') : ''}`; } catch { return 'about:blank'; } });
    const ensureThreeFields = `document.querySelectorAll('iframe[src*="secure-fields.wpay2.gr4vy.app/input.html"]').length === 3`;

    // The checkout rebuilds the Gr4vy secure iframes several times while it
    // settles right after load, which discards anything already typed and can
    // detach a frame mid-fill. So fill each field by re-resolving its frame every
    // attempt, then read the values back and re-fill until they persist.
    for (let pass = 0; pass < 5; pass++) {
      // The checkout may open on a saved-card view; switch to the new-card view
      // so the secure input fields exist (whichever control this build renders).
      await this.page.evaluate(`(() => {
        const radio = document.querySelector('input[name="savedOrNewCards"][value="false"]');
        if (radio) { radio.click(); return; }
        const button = Array.from(document.querySelectorAll('button')).find(node => /new card/i.test(node.textContent || ''));
        if (button) button.click();
      })()`);
      const framesReady = await this.waitForCondition(ensureThreeFields, pass === 0 ? 25_000 : 12_000);
      if (!framesReady) {
        if (await this.valuesPersisted(fields, normalize).catch(() => false)) { this.filled = true; return; }
        if (pass < 4) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
        console.error('[duke] card fill: secure frames did not appear', describeFrames());
        throw new AppError('CARD_FIELDS', 'The secure card fields did not appear in time. Reload the BIG W checkout and prepare again.');
      }
      let filledThisPass = true;
      for (const [type, value] of fields) {
        if (!(await this.fillField(type, value))) { filledThisPass = false; break; }
      }
      // Let the checkout finish re-creating any fields, then confirm the values stuck.
      if (filledThisPass) {
        await new Promise(resolve => setTimeout(resolve, 1200));
        if (await this.valuesPersisted(fields, normalize)) {
          if (opts?.programmaticSubmit) {
            // Purchase mode submits right away: the submit step re-fills and
            // re-clicks Pay until the retailer confirms the request, so any
            // rebuild between here and submission is caught there.
            this.filled = true;
            return;
          }
          // Assist mode leaves the submission to the user, so keep re-filling
          // for a short window so the card is genuinely still in the fields
          // the user is looking at.
          const until = Date.now() + 3000;
          while (Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 700));
            if (await this.valuesPersisted(fields, normalize)) continue;
            console.log('[duke] card fill: secure fields rebuilt again; re-filling');
            let refilled = true;
            for (const [type, value] of fields) if (!(await this.fillField(type, value))) { refilled = false; break; }
            if (!refilled) break;
          }
          this.filled = true;
          return;
        }
      }
      console.log(`[duke] card fill: checkout rebuilt the secure fields (pass ${pass + 1}); filling again`);
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new AppError('CARD_FIELDS', 'The BIG W checkout kept rebuilding the card fields. Prepare a fresh run and try again.', 400);
  }

  // Fill one secure field, re-resolving its frame on every attempt so a frame the
  // checkout rebuilt (detached) is picked up again.
  private async fillField(type: string, value: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const frame = await this.waitFrame(type, 5_000);
      if (frame) {
        try {
          await frame.locator('input:not([type="hidden"])').setTimeout(6_000).fill(value);
          return true;
        } catch { /* frame detached or transient; re-resolve and retry */ }
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return false;
  }

  private async valuesPersisted(fields: [string, string][], normalize: (value?: string) => string): Promise<boolean> {
    const current = await Promise.all(fields.map(([type]) => this.readField(type)));
    return current.every((value, index) => value !== undefined && normalize(value) === normalize(fields[index][1]));
  }

  async submit(prepared: PreparedCheckout, card: PaymentInput, onActionRequired: () => void): Promise<PaymentOutcome> {
    const page = this.page;
    return new Promise<PaymentOutcome>(resolve => {
      let settled = false, observed = false, checking = false, requestedAction = false;
      let pendingReference: string | undefined;
      const unknown: PaymentOutcome = { status: 'unknown', message: 'The payment outcome is not confirmed. Check BIG W order history before another purchase.' };
      const finish = (outcome: PaymentOutcome) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); clearTimeout(vaultDeadline); clearInterval(poll);
        this.gate?.close();
        page.off('response', response); page.off('requestfailed', failed); page.off('close', disconnected);
        page.browser().off('disconnected', disconnected);
        resolve(outcome);
      };
      const action = () => { if (!requestedAction) { requestedAction = true; onActionRequired(); } };
      const response = (event: HTTPResponse) => {
        // Card tokenization against the payment provider failed (for example an
        // expired checkout session): BIG W will never receive a payment, so fail
        // fast with an actionable message instead of waiting for a timeout.
        if (isVaultEndpoint(event.url()) && event.request().method() === 'POST') {
          if (event.status() >= 400) finish({ status: 'declined', message: 'The secure card step failed before BIG W received a payment (the payment session may have expired). Prepare a fresh run and try again.' });
          return;
        }
        if (!isPaymentEndpoint(event.url(), prepared.cartId) || event.request().method() !== 'POST' || !this.gate?.wasAllowed(event.request())) return;
        void event.json().then(value => {
          if (settled) return;
          const body = record(record(value).data ?? value);
          pendingReference = orderReference(body) ?? pendingReference;
          const outcome = interpretPaymentResult(value, event.status());
          if (outcome) finish(outcome);
        }).catch(() => undefined);
      };
      const failed = (event: HTTPRequest) => { if (isPaymentEndpoint(event.url(), prepared.cartId) && !this.gate?.wasBlocked(event)) finish(unknown); };
      const disconnected = () => finish(unknown);
      const deadline = setTimeout(() => finish(unknown), 300_000);
      const vaultDeadline = setTimeout(() => { if (!observed) finish(unknown); }, 20_000);
      const poll = setInterval(() => {
        if (checking || settled) return;
        checking = true;
        void page.evaluate(`(() => {
          const text = document.body?.innerText || '';
          const challenge = /3d.?secure|authenticate|challenge/i.test(location.pathname) || Array.from(document.querySelectorAll('iframe')).some(f => /3ds|challenge/i.test(f.src));
          return { url: location.href, challenge, confirmed: /thank you|order confirmed|order confirmation/i.test(text) };
        })()`).then(state => {
          if (settled) return;
          const data = state as { url: string; challenge: boolean; confirmed: boolean };
          const url = new URL(data.url);
          if (data.challenge || (observed && url.protocol === 'https:' && url.hostname !== 'www.bigw.com.au')) action();
          if (observed && data.confirmed && url.origin === 'https://www.bigw.com.au' && url.pathname.includes('/checkout/confirmation') && pendingReference) {
            finish({ status: 'confirmed', orderNumber: pendingReference });
          }
        }).catch(() => undefined).finally(() => { checking = false; });
      }, 700);
      page.on('response', response); page.on('requestfailed', failed); page.once('close', disconnected); page.browser().once('disconnected', disconnected);
      void (async () => {
        try {
          const session = this.frame('number');
          const binding: PaymentBinding = { cartId: prepared.cartId, cartVersion: prepared.cart.version, totalCents: prepared.cart.total, kind: card.kind };
          if (card.kind === 'new') {
            binding.sessionId = session ? new URL(session.url()).searchParams.get('sessionId') ?? undefined : undefined;
            if (!binding.sessionId || binding.sessionId === 'undefined') {
              finish({ status: 'blocked', code: 'CARD_SESSION', message: 'The secure payment session is not ready. No payment was submitted.' }); return;
            }
          } else { binding.savedCardId = card.cardId; binding.securityCode = card.cvv; }
          this.gate = new PaymentGuard(page, binding, {
            onSent: () => { observed = true; }, onUncertain: () => finish(unknown),
            onPrevented: code => finish({ status: 'blocked', code, message: 'The cart, total, or payment session changed before submission. The request was blocked; prepare a fresh run.' }),
          });
          await this.gate.enable();
          if (card.kind === 'new') {
            const fields: [string, string][] = [['number', card.number], ['expiryDate', card.expiry], ['securityCode', card.cvv]];
            const normalize = (value?: string) => (value ?? '').replace(/\D/g, '');
            const clickPay = `(() => {
              const form = document.querySelector('[data-testid="pay-with-new-card"] form');
              const button = (form && form.querySelector('button[type="submit"]')) || Array.from(document.querySelectorAll('button')).find(node => /Pay .* with credit card/i.test(node.textContent || ''));
              if (button && !button.disabled) { button.click(); return true; }
              return false;
            })()`;
            // The checkout rebuilds the secure fields shortly after fill, which
            // clears the card and turns a Pay click into a silent no-op. Keep
            // re-filling and clicking until a payment request is actually observed.
            // The guard allows only the first submission, so re-clicking is safe.
            for (let attempt = 0; attempt < 6 && !settled && !observed; attempt++) {
              if (!(await this.valuesPersisted(fields, normalize))) {
                try { await this.fill(card); } catch { /* fill logs its own reason */ }
              }
              if (settled || observed) break;
              await page.evaluate(clickPay).catch(() => undefined);
              const until = Date.now() + 4000;
              while (Date.now() < until && !settled && !observed) await new Promise(resolve => setTimeout(resolve, 200));
              if (!settled && !observed) console.log(`[duke] card submit: no payment seen after click ${attempt + 1}; retrying`);
            }
            if (!observed && !settled) finish(unknown);
          } else {
            const fingerprint = await page.evaluate(`window.gr4vyAntiFraud?.f || ''`);
            const value = await this.request(`/storefront/v1/cart/${encodeURIComponent(prepared.cartId)}/pay`, 'POST', {
              cartId: prepared.cartId, cartVersion: prepared.cart.version, deviceFingerprint: fingerprint,
              transactions: { creditCardPaymentStoredInfo: { amountInCents: prepared.cart.total, securityCode: card.cvv, internalPaymentMethodId: card.cardId } },
            });
            const outcome = interpretPaymentResult(value, 200);
            if (outcome) { finish(outcome); return; }
            const body = record(record(value).data ?? value);
            pendingReference = orderReference(body);
            if (typeof body.approvalUrl === 'string') {
              const url = new URL(body.approvalUrl);
              if (url.protocol !== 'https:' || url.username || url.password) { finish(unknown); return; }
              await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            }
          }
        } catch { finish(unknown); }
      })();
    });
  }

  async resetAfterNavigation(): Promise<void> {
    await this.gate?.releaseAfterNavigation();
    this.gate = undefined;
  }

  async clear(): Promise<void> {
    if (!this.filled) return;
    this.filled = false;
    for (const type of ['number', 'expiryDate', 'securityCode']) {
      try {
        await this.frame(type)?.evaluate(`(() => {
          const input = document.querySelector('input:not([type="hidden"])');
          if (!input) return;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      } catch { /* The provider may already have navigated away. */ }
    }
  }
}
