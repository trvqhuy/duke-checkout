import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ArmedCheckout, CartState, CheckoutRun, PaymentInput, PreparedCheckout, ProductInfo, RunRequest, Stage, StoreAdapter } from '../shared/types.ts';
import { normalizeAustralianPhone, parseProductLink, validateRun } from '../shared/validation.ts';
import { AppError, checkAbort, publicError } from './errors.ts';
import { LocalStore, sanitizeRun } from './storage.ts';

export { armedMatches } from '../shared/armed.ts';
import { armedMatches } from '../shared/armed.ts';

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

export class RunManager extends EventEmitter {
  private runs: CheckoutRun[] = [];
  private active?: { id: string; controller: AbortController };
  private jobs = new Map<string, Promise<CheckoutRun>>();
  constructor(private store: LocalStore, private adapter: StoreAdapter) {
    super();
    // Standby keeper: while no run is active, refresh the retailer session long
    // before its token expires so an armed checkout stays ready for hours.
    setInterval(() => {
      if (this.active) return;
      void this.adapter.keepSessionFresh?.().catch(() => undefined);
    }, 60_000).unref();
  }

  get activeRunId(): string | null { return this.active?.id ?? null; }

  async init(): Promise<void> {
    this.runs = await this.store.runs();
    let recovered = false;
    for (const run of this.runs) {
      if (!['queued', 'running', 'action_required'].includes(run.status)) continue;
      recovered = true;
      run.status = run.paymentSubmittedAt ? 'payment_unknown' : 'failed';
      run.error = run.paymentSubmittedAt
        ? { code: 'PAYMENT_UNKNOWN', message: 'The app stopped while payment was in progress. Check BIG W orders before another purchase.' }
        : { code: 'INTERRUPTED', message: 'The app stopped before this run finished. Start a new run to continue.' };
      run.finishedAt = run.updatedAt = new Date().toISOString();
    }
    if (recovered) await this.persist();
  }

  history(): CheckoutRun[] { return this.runs.map(sanitizeRun); }
  get(id: string): CheckoutRun {
    const run = this.runs.find(item => item.id === id);
    if (!run) throw new AppError('NOT_FOUND', 'This run was not found.', 404);
    return sanitizeRun(run);
  }

  private async persist(): Promise<void> { await this.store.saveRuns(this.runs); }
  private publish(run: CheckoutRun): void {
    run.updatedAt = new Date().toISOString();
    run.elapsedMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
    this.emit('change', sanitizeRun(run));
  }
  private report(run: CheckoutRun, stage: Stage, message: string): void {
    run.stage = stage;
    const elapsedMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
    run.events.push({ stage, message, at: new Date().toISOString(), elapsedMs });
    this.publish(run);
  }

  async start(raw: unknown): Promise<CheckoutRun> {
    const input = validateRun(raw);
    const requestId = input.requestId ?? randomUUID();
    const existing = this.runs.find(run => run.requestId === requestId);
    if (existing) return sanitizeRun(existing);
    if (this.active) throw new AppError('RUN_ACTIVE', 'A checkout is already running. Let it finish or cancel before starting another.', 409);
    const code = parseProductLink(input.productUrl).code;
    const now = new Date().toISOString();
    const run: CheckoutRun = {
      id: randomUUID(), requestId, mode: input.mode, status: 'queued', stage: 'connect',
      productCode: code, productUrl: input.productUrl, quantity: input.quantity,
      maxTotalCents: input.maxTotalCents, profileName: input.profile.name,
      startedAt: now, updatedAt: now, elapsedMs: 0, events: [],
    };
    const controller = new AbortController();
    this.active = { id: run.id, controller };
    this.runs.unshift(run);
    try { await this.persist(); }
    catch (error) { this.active = undefined; this.runs.shift(); input.card = undefined; throw error; }
    const job = Promise.resolve().then(() => this.execute(run, input, controller.signal));
    this.jobs.set(run.id, job);
    void job.finally(() => this.jobs.delete(run.id));
    this.publish(run);
    return sanitizeRun(run);
  }

  async wait(id: string): Promise<CheckoutRun> {
    return this.jobs.get(id) ?? this.get(id);
  }

  cancel(id: string): CheckoutRun {
    const run = this.runs.find(item => item.id === id);
    if (!run) throw new AppError('NOT_FOUND', 'This run was not found.', 404);
    if (this.active?.id !== id) return sanitizeRun(run);
    if (run.paymentSubmittedAt) throw new AppError('PAYMENT_IN_PROGRESS', 'Payment is already being submitted. Waiting for its outcome avoids an uncertain cancellation.', 409);
    this.active.controller.abort();
    this.report(run, run.stage, 'Cancellation requested. Finishing the current pre-payment step.');
    return sanitizeRun(run);
  }

  async resolve(id: string, resolution: 'confirmed' | 'not_purchased', orderNumber?: string): Promise<CheckoutRun> {
    const run = this.runs.find(item => item.id === id);
    if (!run || run.status !== 'payment_unknown') throw new AppError('INVALID_RESOLUTION', 'Only an unknown payment outcome can be resolved.');
    if (resolution === 'confirmed') {
      if (!orderNumber || !/^[\w-]{3,80}$/.test(orderNumber)) throw new AppError('ORDER_REFERENCE', 'Enter the order reference shown in your BIG W order history.');
      run.status = 'succeeded'; run.orderNumber = orderNumber; run.error = undefined;
      this.report(run, 'complete', 'Order confirmed from your BIG W order-history check.');
    } else {
      run.status = 'failed'; run.error = { code: 'OUTCOME_CHECKED', message: 'You checked BIG W order history and marked this purchase as not placed.' };
      this.report(run, 'complete', 'Unknown outcome checked; a new purchase run is now available.');
    }
    await this.persist();
    return sanitizeRun(run);
  }

  private async execute(run: CheckoutRun, input: RunRequest, signal: AbortSignal): Promise<CheckoutRun> {
    let mayHaveSubmitted = false;
    let keepFilledCard = false;
    let card: PaymentInput | undefined = input.card;
    try {
      run.status = 'running';
      this.report(run, 'connect', 'Checking your existing Chrome session.');
      await this.adapter.connect(); checkAbort(signal);
      // Fast paths: a cart-ready armed checkout skips inspection and every cart
      // mutation; a standby arm (pre-release product) skips inspection only, so
      // the run adds the cart itself at the release moment.
      const armed = this.adapter.armedState?.() ?? null;
      let fast = !!armed && armed.level === 'cart-ready' && armedMatches(armed, input);
      let standby = !fast && !!armed && armed.level === 'standby' && armedMatches(armed, input);
      let prepared: PreparedCheckout | undefined;
      if (fast && armed) {
        this.report(run, 'inspect', 'Armed checkout matches this run — product, cart, and contact are already prepared.');
        run.product = armed.product; this.publish(run);
        const candidate: PreparedCheckout = { cartId: armed.cartId, cart: armed.cart, product: armed.product };
        try {
          candidate.cart = await this.adapter.verify(candidate, input); checkAbort(signal);
          guardCart(candidate.cart, input);
          prepared = candidate;
        } catch (error) {
          console.warn(`[duke] armed checkout unusable (${publicError(error).code}); preparing from scratch`);
          this.adapter.disarm?.();
          fast = false;
        }
      } else if (standby && armed) {
        this.report(run, 'inspect', 'Armed standby matches this run — using the prepared session and stored product details, then adding the cart.');
        run.product = armed.product; this.publish(run);
        prepared = await this.adapter.prepare(input, armed.product, (stage, message) => this.report(run, stage, message), signal); checkAbort(signal);
        prepared.cart = await this.adapter.verify(prepared, input); checkAbort(signal);
        guardCart(prepared.cart, input);
        this.adapter.disarm?.();
      }
      if (!prepared) {
        this.report(run, 'inspect', 'Checking the product, price, and delivery availability.');
        const product: ProductInfo = await this.adapter.inspect(input.productUrl, input.profile); checkAbort(signal);
        run.product = product; this.publish(run);
        if (!product.available) throw new AppError('UNAVAILABLE', 'This product is not currently available for delivery to the selected address.');
        if (product.requiresVariant) throw new AppError('VARIANT_REQUIRED', 'This link needs a specific product variant. Choose the size or colour on BIG W and use that item’s link.');
        if (product.priceCents * input.quantity + product.deliveryCents > input.maxTotalCents) throw new AppError('BUDGET', 'The current item price and estimated delivery exceed your maximum delivered total.');
        prepared = await this.adapter.prepare(input, product, (stage, message) => this.report(run, stage, message), signal); checkAbort(signal);
        prepared.cart = await this.adapter.verify(prepared, input); checkAbort(signal);
        guardCart(prepared.cart, input);
      }
      run.totalCents = prepared.cart.total; run.deliveryCents = prepared.cart.deliveryCost;
      if (fast) {
        await this.adapter.revealPrepared?.(prepared, (stage, message) => this.report(run, stage, message), signal, { reuseMountedPage: true }); checkAbort(signal);
      }
      if (input.mode === 'prepare') {
        run.status = 'ready'; this.report(run, 'complete', 'Checkout is ready in Chrome. Prepare mode finished without payment.');
      } else if (input.mode === 'afterpay') {
        this.report(run, 'payment', 'Selecting Afterpay and opening its checkout.');
        const opened = await this.adapter.startAfterpay(); checkAbort(signal);
        run.status = 'ready';
        this.report(run, 'complete', opened
          ? 'Afterpay opened. Complete the Afterpay checkout in the browser tab.'
          : 'Afterpay is selected. If its window did not open, press “Pay … with Afterpay” in the BIG W tab.');
      } else {
        if (!card) throw new AppError('PAYMENT_REQUIRED', 'A payment method is required.');
        this.report(run, 'payment', 'Filling the retailer’s secure payment fields.');
        await this.adapter.fillCard(card, { programmaticSubmit: input.mode !== 'assist' }); checkAbort(signal);
        if (input.mode === 'assist') {
          // Fill only: leave the card in the retailer's secure fields and let the
          // user press Pay. Nothing is submitted by the app, so there is no
          // payment outcome to reconcile and the card fields must not be cleared.
          keepFilledCard = true;
          run.status = 'ready';
          prepared.cart = await this.adapter.verify(prepared, input); checkAbort(signal);
          guardCart(prepared.cart, input);
          run.totalCents = prepared.cart.total; run.deliveryCents = prepared.cart.deliveryCost;
          this.report(run, 'complete', 'Card filled in Chrome. Press “Pay” in the BIG W tab to submit.');
        } else {
          prepared.cart = await this.adapter.verify(prepared, input); checkAbort(signal);
          guardCart(prepared.cart, input);
          run.totalCents = prepared.cart.total; run.deliveryCents = prepared.cart.deliveryCost;
          run.paymentSubmittedAt = new Date().toISOString();
          this.report(run, 'payment', 'Submitting payment once and waiting for BIG W’s response.');
          await this.persist(); checkAbort(signal);
          mayHaveSubmitted = true;
          const outcome = await this.adapter.pay(prepared, card, () => {
            run.status = 'action_required';
            this.report(run, 'payment', 'Your bank needs authentication. Complete it in the existing Chrome checkout tab.');
          });
          if (outcome.status === 'confirmed') {
            run.status = 'succeeded'; run.orderNumber = outcome.orderNumber;
            this.report(run, 'complete', 'BIG W confirmed the order.');
          } else if (outcome.status === 'declined') {
            run.status = 'failed'; run.error = { code: 'PAYMENT_DECLINED', message: outcome.message };
            // The card was not accepted: keep it in the fields so it can be checked
            // or retried rather than silently cleared.
            keepFilledCard = true;
            this.report(run, 'payment', outcome.message);
          } else if (outcome.status === 'blocked') {
            run.status = 'failed'; run.error = { code: outcome.code, message: outcome.message };
            run.paymentSubmittedAt = undefined;
            keepFilledCard = true;
            this.report(run, 'payment', outcome.message);
          } else {
            run.status = 'payment_unknown'; run.error = { code: 'PAYMENT_UNKNOWN', message: outcome.message };
            this.report(run, 'payment', outcome.message);
          }
        }
      }
    } catch (error) {
      const failure = publicError(error);
      if (mayHaveSubmitted) {
        run.status = 'payment_unknown';
        run.error = { code: 'PAYMENT_UNKNOWN', message: 'The payment outcome is not confirmed. Check BIG W order history before purchasing again.' };
      } else {
        run.status = signal.aborted ? 'cancelled' : 'failed'; run.error = failure;
        run.paymentSubmittedAt = undefined;
      }
      this.report(run, run.stage, run.error.message);
    } finally {
      card = undefined; input.card = undefined;
      // Fill-only mode intentionally leaves the card in the retailer's fields so
      // the user can submit it themselves.
      if (!keepFilledCard) await this.adapter.clearSensitiveFields().catch(() => undefined);
      run.finishedAt = new Date().toISOString();
      this.active = undefined;
      this.publish(run);
      try { await this.persist(); }
      catch {
        if (!run.error) run.error = { code: 'HISTORY_WRITE', message: 'The result is shown here, but local history could not be updated. Keep this order reference.' };
        this.publish(run);
      }
    }
    return sanitizeRun(run);
  }
}
