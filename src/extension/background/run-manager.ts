// RunManager — the service-worker port of src/server/checkout.ts.
//
// The run lifecycle, guards, events, and messages are ported verbatim. The only
// deliberate deviations, forced by the extension runtime, are:
//
// 1. Storage. Run history lives in the extension store (getHistory/pushRun in
//    ../lib/storage.ts) instead of the server's LocalStore, and every run is
//    run through the shared sanitizeRun before it is broadcast or persisted, so
//    the CheckoutRun objects kept in history are the sanitized shape and no card
//    material can reach storage. lib/storage.pushRun upserts by run id, so the
//    server's whole-snapshot rewrite becomes a per-run history update.
// 2. Active-run recovery. The in-memory runs[] + active mirror the server, and
//    the active run is additionally mirrored into chrome.storage.session under
//    dukeRunState ({ run }) on every change (persistState), so a restarted
//    service worker can recover it. init() loads history, runs the server's
//    recovery over it, and also folds in a dukeRunState run that is unfinished
//    and absent from history.
// 3. Events. The EventEmitter is replaced by a module-level broadcast() that
//    sends { type: 'run.update', payload: sanitizeRun(run) } over
//    chrome.runtime.sendMessage.
// 4. No keeper interval. The Stage-1 keeper owns session refresh, so the
//    constructor only stores the adapter.
// 5. connect is optional. The extension adapter establishes the bridge per call,
//    so execute() uses `await this.adapter.connect?.()`.
// 6. crypto.randomUUID() replaces node:crypto's randomUUID (both produce a v4
//    UUID; the Web Crypto global is the one available in a service worker).
import type { ArmedCheckout, CartState, CheckoutRun, PaymentInput, PaymentOutcome, PreparedCheckout, ProductInfo, Profile, RunRequest, Stage, StageReporter } from '../../shared/types.ts';
import { parseProductLink, validateRun } from '../../shared/validation.ts';
import { guardCart } from '../../shared/cart-guard.ts';
import { sanitizeRun } from '../../shared/run-sanitize.ts';
import { armedMatches } from '../../shared/armed.ts';
import { AppError, checkAbort, publicError } from '../../server/errors.ts';
import { getHistory, pushRun } from '../lib/storage.ts';

// Exactly the adapter surface this manager uses, so tests can pass a fake.
export interface RunAdapter {
  connect?(): Promise<unknown>;
  inspect(productUrl: string, profile: Profile): Promise<ProductInfo>;
  prepare(input: RunRequest, product: ProductInfo, report: StageReporter, signal: AbortSignal): Promise<PreparedCheckout>;
  verify(prepared: PreparedCheckout, input: RunRequest): Promise<CartState>;
  armedState?(): ArmedCheckout | null;
  disarm?(): void;
  revealPrepared?(prepared: PreparedCheckout, report: StageReporter, signal: AbortSignal, opts?: { reuseMountedPage?: boolean }): Promise<void>;
  fillCard(card: PaymentInput, opts?: { programmaticSubmit?: boolean }): Promise<void>;
  startAfterpay(): Promise<boolean>;
  pay(prepared: PreparedCheckout, card: PaymentInput, onActionRequired: () => void): Promise<PaymentOutcome>;
  clearSensitiveFields(): Promise<void>;
}

function broadcast(event: { type: 'run.update'; payload: unknown }): void {
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

export class RunManager {
  private runs: CheckoutRun[] = [];
  private active?: { id: string; controller: AbortController };
  private jobs = new Map<string, Promise<CheckoutRun>>();
  constructor(private adapter: RunAdapter) {}

  get activeRunId(): string | null { return this.active?.id ?? null; }

  async init(): Promise<void> {
    this.runs = (await getHistory()).map(sanitizeRun);
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
    // A service worker can be torn down mid-run; the active run was mirrored to
    // session storage so an interrupted run that never reached history is still
    // recovered with the same logic.
    const stored = (await chrome.storage.session.get(['dukeRunState'])).dukeRunState as { run?: unknown } | null | undefined;
    const pending = stored?.run ? sanitizeRun(stored.run) : undefined;
    if (pending && ['queued', 'running', 'action_required'].includes(pending.status) && !this.runs.some(run => run.id === pending.id)) {
      recovered = true;
      pending.status = pending.paymentSubmittedAt ? 'payment_unknown' : 'failed';
      pending.error = pending.paymentSubmittedAt
        ? { code: 'PAYMENT_UNKNOWN', message: 'The app stopped while payment was in progress. Check BIG W orders before another purchase.' }
        : { code: 'INTERRUPTED', message: 'The app stopped before this run finished. Start a new run to continue.' };
      pending.finishedAt = pending.updatedAt = new Date().toISOString();
      this.runs.unshift(pending);
    }
    if (stored?.run) await chrome.storage.session.remove(['dukeRunState']).catch(() => undefined);
    if (recovered) await this.persist();
  }

  history(): CheckoutRun[] { return this.runs.map(sanitizeRun); }
  get(id: string): CheckoutRun {
    const run = this.runs.find(item => item.id === id);
    if (!run) throw new AppError('NOT_FOUND', 'This run was not found.', 404);
    return sanitizeRun(run);
  }

  private async persist(): Promise<void> {
    // History is keyed by run id; only write runs whose sanitized form differs
    // from what is already stored (oldest-first so the newest stays first).
    const known = new Map((await getHistory()).map(item => [item.id, JSON.stringify(item)]));
    for (const run of [...this.runs].reverse()) {
      const value = sanitizeRun(run);
      if (known.get(value.id) === JSON.stringify(value)) continue;
      await pushRun({ ...value });
    }
  }
  private persistState(): void {
    const run = this.active ? this.runs.find(item => item.id === this.active!.id) : undefined;
    void chrome.storage.session.set({ dukeRunState: run ? { run: sanitizeRun(run) } : null }).catch(() => undefined);
  }
  private publish(run: CheckoutRun): void {
    run.updatedAt = new Date().toISOString();
    run.elapsedMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
    broadcast({ type: 'run.update', payload: sanitizeRun(run) });
    this.persistState();
  }
  private report(run: CheckoutRun, stage: Stage, message: string): void {
    run.stage = stage;
    const elapsedMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
    run.events.push({ stage, message, at: new Date().toISOString(), elapsedMs });
    this.publish(run);
  }

  async start(raw: unknown): Promise<CheckoutRun> {
    const input = validateRun(raw);
    const requestId = input.requestId ?? crypto.randomUUID();
    const existing = this.runs.find(run => run.requestId === requestId);
    if (existing) return sanitizeRun(existing);
    if (this.active) throw new AppError('RUN_ACTIVE', 'A checkout is already running. Let it finish or cancel before starting another.', 409);
    const code = parseProductLink(input.productUrl).code;
    const now = new Date().toISOString();
    const run: CheckoutRun = {
      id: crypto.randomUUID(), requestId, mode: input.mode, status: 'queued', stage: 'connect',
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
      await this.adapter.connect?.(); checkAbort(signal);
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
