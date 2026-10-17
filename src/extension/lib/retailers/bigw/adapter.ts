// BIG W retailer adapter for the extension, adapted from the server original
// (src/server/browser/bigw.ts). Same endpoints, bodies, stagger, and product
// semantics; deliberate deviations forced by the bridge (no live Page):
// (a) steps are acquire-based — each public step starts a fresh bridge handle
//     via the acquire() seam instead of this.session()/livePage(); the
//     RetailerAdapter interface methods are acquire-based, not handle-based;
// (b) inspect() runs the same store/location resolution, but locationFor()
//     always resolves the storeId through the stores API (no page-context
//     storeId is available);
// (c) prepareCart() has no page context, so the existing-cart reuse branch and
//     the cart publish into the page's local state are skipped (Stage 2);
// (d) arm()/standbyArm() skip the checkout-page preload warm-up (Stage 2 adds
//     it via the checkout driver); the STANDBY downgrade notes are unchanged;
// (e) verify() skips the page-context cartId comparison and only re-invalidates
//     the cart through the bridge;
// (f) no retry logic — bridgeRequest throws immediately; stage 2 revisits
//     anti-bot recovery (the server request() retries 403s once and transient
//     GETs twice with backoff).
// (g) Stage-2 methods are driver-backed (see types.ts DriverHandle):
//     CDP Frame objects become numeric driver frameIds (resolved from
//     handle.driver.frames()); the server's page 'response'/'requestfailed'
//     listeners become driver.observe() polling (the observed entries are the
//     authoritative record — the MAIN-world guard is advisory); the
//     setRequestInterception payment fence becomes the MAIN-world fetch guard
//     toggled with driver.guardEnable/guardDisable; page.evaluate() calls
//     become driver messages (driver.ready/state/clickPay/newCardView/
//     continueToPayment/clickAfterpay/field.get/set/clear). The observer's
//     ring buffer outlives a run, so the optional driver.observeClear() drops
//     stale entries before each submission.
// (h) BridgeHandle.driver is optional so the Stage-1 acquire sites keep
//     compiling; Stage-2 methods raise BROWSER_ATTENTION when it is absent.
// (i) revealPrepared also activates the tab on the reuse-mounted-page path
//     (the plan's explicit behaviour); the server only calls ready() there.
// (j) pay() accepts an optional AbortSignal the server's submit() does not.
// (k) startAfterpay() returns whether a click was detected and does not throw
//     AFTERPAY_UNAVAILABLE: a content script cannot observe the Afterpay
//     hand-off (redirect/popup) from the service worker.
// (l) clearSensitiveFields()/resetAfterNavigation() reset a per-adapter
//     `filled` flag instead of a persistent PaymentDriver's page state; the
//     gate is the MAIN-world guard, so resetAfterNavigation() is a flag reset.
// The bridge reads the live token per request, so no session renewal step
// exists here.
import { parseProductLink } from '../../../../shared/validation.ts';
import { STANDBY_CODES } from '../../../../shared/armed.ts';
import { buildProductInfo, parseCartState, record, string } from '../../../../server/browser/bigw-model.ts';
import { isPaymentEndpoint, isVaultEndpoint, interpretPaymentResult } from '../../../../server/browser/payment.ts';
import { AppError, checkAbort } from '../../../../server/errors.ts';
import { bridgeRequest } from '../../../background/bridge-client.ts';
import { scopesForPath } from '../../../content/api-bridge-main.ts';
import type { BridgeHandle, DriverFrame, DriverHandle, RetailerAdapter } from '../types.ts';
import type { PaymentBinding } from '../../../../shared/payment-check.ts';
import type { ArmedCheckout, CartState, PaymentInput, PaymentOutcome, PreparedCheckout, ProductInfo, Profile, RunRequest, StageReporter } from '../../../../shared/types.ts';

interface Location { storeId: string; zone?: string; zoneType?: string }

const SECURE_ORIGIN = 'https://secure-fields.wpay2.gr4vy.app';
const CHECKOUT_URL = 'https://www.bigw.com.au/checkout/delivery';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Verbatim from src/server/browser/payment.ts (not exported there): a merchant
// order reference is a short word-ish string or number.
function orderReference(body: Record<string, unknown>): string | undefined {
  const value = body.orderNumber;
  return (typeof value === 'string' || typeof value === 'number') && /^[\w-]{3,80}$/.test(String(value)) ? String(value) : undefined;
}

export class BigWExtensionAdapter implements RetailerAdapter {
  readonly urlPattern = /https:\/\/www\.bigw\.com\.au\/product\/[^/]+\/p\/(\d+)/;
  private location?: Location;
  // Set once a card fill persisted secure-field values; clearSensitiveFields()
  // only wipes when a fill actually happened (same gate as PaymentDriver.clear).
  private filled = false;
  constructor(private acquire: () => Promise<BridgeHandle>) {}

  // Every store call is bridged through the work tab. Authenticated calls carry
  // their required scopes so the MAIN world resolves a matching token.
  private async req(handle: BridgeHandle, path: string, method = 'GET', body?: unknown, origin = 'https://api.bigw.com.au', publicRequest = false): Promise<unknown> {
    const args = { origin, path, method, body, publicRequest, ...(publicRequest ? {} : { scopes: scopesForPath(path, method) }) };
    return bridgeRequest(handle.sender, handle.tabId, args);
  }

  // Public passthrough for the service worker's keeper: the same acquire seam
  // the adapter itself uses.
  acquirePublic(): Promise<BridgeHandle> { return this.acquire(); }

  private async locationFor(handle: BridgeHandle, profile: Profile): Promise<Location> {
    const address = profile.deliveryAddress;
    const zones = await this.req(handle, `/warehouse-customer/v1/postcode/${encodeURIComponent(address.postcode)}?suburb=${encodeURIComponent(address.suburb.toUpperCase())}`, 'GET', undefined, 'https://api.bigw.com.au', true);
    const zone = record(Array.isArray(zones) ? zones[0] : zones);
    if (zone.state && zone.state !== address.state) throw new AppError('ADDRESS_LOCATION', 'The suburb/postcode does not match the selected state. Check the delivery address.');
    const data = await this.req(handle, '/api/stores/v0/list', 'GET', undefined, 'https://api.bigw.com.au', true);
    const stores = Array.isArray(data) ? data : record(data).stores;
    const store = Array.isArray(stores) ? stores.find(item => string(record(record(item).address).state) === address.state) ?? stores[0] : undefined;
    const storeId = string(record(store).id, string(record(store).name));
    if (!storeId) throw new AppError('STORE_REQUIRED', 'Choose a local store once on BIG W, then prepare again.');
    return { storeId, zone: string(zone.miraklZone) || undefined, zoneType: string(zone.zoneClassification) || undefined };
  }

  async inspect(productUrl: string, profile: Profile): Promise<ProductInfo> {
    const handle = await this.acquire();
    const { code, url } = parseProductLink(productUrl);
    // The postcode lookup, store resolution, product details, and price lookups
    // are independent, so run them together; only the availability call needs
    // the resolved store.
    const [location, products, prices] = await Promise.all([
      this.locationFor(handle, profile),
      this.req(handle, `/apim/product-price-api/v1/products?productCodes=${code}`, 'GET', undefined, 'https://apix.bigw.com.au', true),
      this.req(handle, `/apim/product-price-api/v1/prices/${code}?state=${profile.deliveryAddress.state}`, 'GET', undefined, 'https://apix.bigw.com.au', true),
    ]);
    this.location = location;
    const query = new URLSearchParams({ storeId: location.storeId, deliveryPostcode: profile.deliveryAddress.postcode, deliverySuburb: profile.deliveryAddress.suburb.toUpperCase() });
    // BIG W's standalone availability endpoint intermittently rejects requests
    // and can stall the whole inspection. It is advisory: the cart's own
    // fulfilment response is authoritative, so give it a short budget and
    // otherwise proceed without it.
    let availability: unknown = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      availability = await Promise.race([
        this.req(handle, `/api/availability/v0/product/${code}?${query}`, 'GET', undefined, 'https://api.bigw.com.au', true),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2_000); }),
      ]);
    } catch (error) {
      if (!(error instanceof AppError) || !['REQUEST_NETWORK', 'REQUEST_TIMEOUT'].includes(error.code)) throw error;
    } finally {
      clearTimeout(timer);
    }
    return buildProductInfo(url, products, prices, availability);
  }

  private apiAddress(address: Profile['deliveryAddress'], profile: Profile): Record<string, unknown> {
    return { ...address, suburb: address.suburb.toUpperCase(), firstName: profile.firstName, lastName: profile.lastName, phonenumber: profile.phone, businessName: '' };
  }

  // Everything cart-related: create the cart, set fulfilment, contact, billing,
  // and recalculate. Used by a normal run and by arm-ahead-of-time preparation.
  async prepareCart(input: RunRequest, product: ProductInfo, report: StageReporter, signal: AbortSignal): Promise<PreparedCheckout> {
    const handle = await this.acquire();
    const location = this.location ?? await this.locationFor(handle, input.profile);
    const address = input.profile.deliveryAddress;
    report('cart', 'Preparing a cart containing only the requested item.');
    checkAbort(signal);
    let cart = parseCartState(await this.req(handle, '/storefront/v1/cart/create', 'POST', {
      storeId: location.storeId, postcode: address.postcode, suburb: address.suburb.toUpperCase(), state: address.state,
      productCode: product.code, quantity: input.quantity, salesChannel: 'website',
    }));
    if (!cart.id.startsWith('CT_')) throw new AppError('CHECKOUT_VERSION', 'This session returned a different BIG W checkout implementation. Preparation stopped before payment.');
    const id = encodeURIComponent(cart.id);
    // The three cart detail updates are independent of each other; only the
    // recalculation must run after all of them. They start together with a small
    // stagger so the retailer's edge does not see an identical-millisecond burst.
    report('contact', 'Applying validated delivery and billing details.');
    const mutations: Array<[number, () => Promise<unknown>]> = [
      [0, () => this.req(handle, `/storefront/v1/cart/${id}/update-details?channel=web`, 'POST', {
        firstName: input.profile.firstName, lastName: input.profile.lastName, phone: input.profile.phone,
        authorityToLeave: false, deliveryAddress: this.apiAddress(address, input.profile), orderType: 'DELIVERY', fulfilmentType: 'DELIVERY',
      })],
      [120, () => this.req(handle, `/storefront/v1/cart/${id}/fulfilment-preference?channel=web`, 'POST', {
        postcode: address.postcode, suburb: address.suburb.toUpperCase(), state: address.state,
        pickupStore: location.storeId, pickupStoresNearby: [location.storeId],
      })],
      [240, () => this.req(handle, `/storefront/v1/cart/${id}/billing-address?channel=web`, 'POST', this.apiAddress(input.profile.billingSame ? address : input.profile.billingAddress!, input.profile))],
    ];
    await Promise.all(mutations.map(([delay, call]) => new Promise((resolve, reject) => setTimeout(() => call().then(resolve, reject), delay))));
    checkAbort(signal);
    await this.req(handle, `/storefront/v1/cart/${id}/recalculate?channel=web`, 'POST', {
      salesChannel: 'website', suburb: address.suburb.toUpperCase(), state: address.state,
      postcode: address.postcode, storeId: location.storeId, pickupStoresNearby: [location.storeId],
    });
    return { cartId: cart.id, cart, product };
  }

  // Arm ahead of time: run every preparation step that does not need the user
  // watching. A later matching run skips straight to the payment.
  // Pre-release products that cannot enter a cart yet arm as 'standby' instead:
  // product details and location are ready, and the run adds the cart itself at
  // the release moment.
  async arm(input: RunRequest, report: StageReporter, signal: AbortSignal): Promise<ArmedCheckout> {
    const product = await this.inspect(input.productUrl, input.profile);
    if (product.requiresVariant) throw new AppError('VARIANT_REQUIRED', 'This link needs a specific product variant. Choose the size or colour on BIG W and use that item’s link.');
    if (!product.available) {
      return this.standbyArm(input, product, 'The product cannot be checked out yet. The session and checkout page stay warm — starting at the release moment will add it to the cart and check out.');
    }
    let prepared: PreparedCheckout;
    try {
      prepared = await this.prepareCart(input, product, report, signal);
    } catch (error) {
      if (error instanceof AppError && STANDBY_CODES.includes(error.code)) {
        return this.standbyArm(input, product, `The cart is not accepting this product yet (${error.code}). The session and checkout page stay warm — starting at the release moment will add it and check out.`);
      }
      throw error;
    }
    return {
      productUrl: input.productUrl, productCode: product.code, quantity: input.quantity,
      maxTotalCents: input.maxTotalCents, profile: input.profile, product,
      cartId: prepared.cartId, cart: prepared.cart, armedAt: new Date().toISOString(),
      level: 'cart-ready',
    };
  }

  // A standby arm for pre-release products: nothing cart-related is possible
  // yet, but the resolved product details (and, by the time a run fires, a warm
  // work tab via the same acquire seam) keep the release-moment run fast.
  private standbyArm(input: RunRequest, product: ProductInfo, note: string): ArmedCheckout {
    return {
      productUrl: input.productUrl, productCode: product.code, quantity: input.quantity,
      maxTotalCents: input.maxTotalCents, profile: input.profile, product,
      cartId: '', cart: { id: '', version: 0, total: 0, deliveryCost: 0, entries: [] },
      armedAt: new Date().toISOString(), level: 'standby', note,
    };
  }

  async verify(prepared: PreparedCheckout, input: RunRequest): Promise<CartState> {
    const handle = await this.acquire();
    return parseCartState(await this.req(handle, `/storefront/v1/cart/${encodeURIComponent(prepared.cartId)}?state=${input.profile.deliveryAddress.state}&channel=web`));
  }

  // -------------------------------------------------------------------------
  // Stage 2: driver-backed checkout (fill / pay / reveal / clear / afterpay)
  // -------------------------------------------------------------------------

  private driverOf(handle: BridgeHandle): DriverHandle {
    if (!handle.driver) throw new AppError('BROWSER_ATTENTION', 'The BIG W checkout driver is not available. Open the BIG W checkout tab and try again.');
    return handle.driver;
  }

  private isSecureFrame(frame: DriverFrame, type: string): boolean {
    try {
      const url = new URL(frame.url);
      return url.origin === SECURE_ORIGIN && url.pathname === '/input.html' && url.searchParams.get('type') === type;
    } catch { return false; }
  }

  private async frameOfType(driver: DriverHandle, type: string): Promise<DriverFrame | undefined> {
    const frames = await driver.frames();
    return frames.find(frame => this.isSecureFrame(frame, type));
  }

  // The secure iframes appear in the checkout slightly before the driver's
  // frame list registers them, so a plain lookup can miss one and fail
  // instantly (same reason as payment.ts waitFrame).
  private async waitFrame(driver: DriverHandle, type: string, timeout: number): Promise<DriverFrame | undefined> {
    const existing = await this.frameOfType(driver, type).catch(() => undefined);
    if (existing) return existing;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await sleep(250);
      const frame = await this.frameOfType(driver, type).catch(() => undefined);
      if (frame) return frame;
    }
    return this.frameOfType(driver, type).catch(() => undefined);
  }

  private async readField(driver: DriverHandle, type: string): Promise<string | undefined> {
    const frame = await this.frameOfType(driver, type);
    if (!frame) return undefined;
    try {
      const result = await driver.sendFrame(frame.frameId, { type: 'driver.field.get' }) as { value?: string } | undefined;
      return result?.value;
    } catch { return undefined; }
  }

  private async valuesPersisted(driver: DriverHandle, fields: [string, string][], normalize: (value?: string) => string): Promise<boolean> {
    const current = await Promise.all(fields.map(([type]) => this.readField(driver, type)));
    return current.every((value, index) => value !== undefined && normalize(value) === normalize(fields[index][1]));
  }

  private async fillField(driver: DriverHandle, type: string, value: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const frame = await this.waitFrame(driver, type, 5_000);
      if (frame) {
        try {
          await driver.sendFrame(frame.frameId, { type: 'driver.field.set', value });
          return true;
        } catch { /* frame detached or transient; re-resolve and retry */ }
      }
      await sleep(400);
    }
    return false;
  }

  private async waitForHasThreeFields(driver: DriverHandle, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const state = await driver.sendTop({ type: 'driver.ready' }) as { hasThreeFields?: boolean } | undefined;
        if (state?.hasThreeFields) return true;
      } catch { /* navigation; retry */ }
      await sleep(250);
    }
    return false;
  }

  private async waitForReady(driver: DriverHandle, timeout: number, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      checkAbort(signal);
      try {
        const state = await driver.sendTop({ type: 'driver.ready' }) as { ready?: boolean } | undefined;
        if (state?.ready === true) return true;
      } catch { /* navigation; retry */ }
      await sleep(250);
    }
    return false;
  }

  // Bring the prepared checkout on screen. Only a caller that has not mutated
  // the cart since the page loaded may reuse the mounted page (the armed fast
  // path); a fresh preparation navigates so the page reflects the new cart.
  async revealPrepared(prepared: PreparedCheckout, report: StageReporter, signal: AbortSignal, opts?: { reuseMountedPage?: boolean }): Promise<void> {
    const handle = await this.acquire();
    const driver = this.driverOf(handle);
    const url = await driver.url().catch(() => '');
    if (opts?.reuseMountedPage && /\/checkout\//.test(url)) {
      report('payment', 'The armed checkout is already open — confirming its secure fields.');
      await driver.activate();
      await this.ready(handle, signal);
      return;
    }
    report('payment', 'Opening the prepared checkout.');
    await driver.navigate(CHECKOUT_URL);
    await driver.activate();
    // A fresh navigation invalidates any guard left over from a prior attempt.
    await driver.guardDisable().catch(() => undefined);
    await this.ready(handle, signal);
  }

  // Port of PaymentDriver.ready(): poll the checkout driver until the secure
  // fields (or a Continue-to-Payment button) appear, recovering from a drifted
  // tab, then drive the contact step if the checkout is not yet on payment.
  private async ready(handle: BridgeHandle, signal: AbortSignal): Promise<void> {
    const driver = this.driverOf(handle);
    const readReady = async (): Promise<{ ready: boolean; continueButton: boolean }> => {
      try {
        const state = await driver.sendTop({ type: 'driver.ready' }) as { ready?: boolean; continueButton?: boolean } | undefined;
        return { ready: state?.ready === true, continueButton: state?.continueButton === true };
      } catch { return { ready: false, continueButton: false }; }
    };
    const deadline = Date.now() + 60_000;
    let lastRecover = Date.now();
    let seen = false;
    while (Date.now() < deadline) {
      checkAbort(signal);
      const state = await readReady();
      if (state.ready || state.continueButton) { seen = true; break; }
      // If the working tab has drifted off the checkout (for example a stray
      // navigation left it on the preparation document), reopen the checkout.
      try {
        const url = await driver.url();
        if (!/\/checkout\//.test(url) && Date.now() - lastRecover > 6_000) {
          lastRecover = Date.now();
          console.log(`[duke] ready: tab drifted to ${url.slice(0, 60)}; reopening checkout`);
          await driver.navigate(CHECKOUT_URL).catch(() => undefined);
        }
      } catch { /* page busy; retry */ }
      await sleep(300);
    }
    if (!seen) throw new AppError('PAYMENT_NOT_READY', 'BIG W’s payment form did not become ready. Check the checkout tab for a sign-in or address requirement.');
    checkAbort(signal);
    if (await this.waitForReady(driver, 1_000, signal)) return;
    // The contact step is showing: press Continue, tolerating navigation too.
    const continueDeadline = Date.now() + 30_000;
    while (Date.now() < continueDeadline) {
      checkAbort(signal);
      await driver.sendTop({ type: 'driver.continueToPayment' }).catch(() => undefined);
      if (await this.waitForReady(driver, 1_500, signal)) return;
    }
    throw new AppError('CONTACT_REQUIRED', 'BIG W needs contact or address details corrected in the checkout tab. Check the selected profile.');
  }

  // Port of PaymentDriver.fill(): saved cards are validated through the
  // bridge; new cards fill the three Gr4vy secure frames, re-resolving each
  // frame and re-filling until the values persist (the checkout rebuilds them).
  async fillCard(card: PaymentInput, opts?: { programmaticSubmit?: boolean }): Promise<void> {
    const handle = await this.acquire();
    const driver = this.driverOf(handle);
    if (card.kind === 'saved') {
      const cards = await this.req(handle, '/storefront/v1/cart/saved-cards');
      if (!Array.isArray(cards) || !cards.some(item => record(item).id === card.cardId)) throw new AppError('SAVED_CARD', 'This saved card is no longer available. Import the current BIG W details again.');
      return;
    }
    // Secure-field locators need an active renderer for stable layout/focus.
    await driver.activate();
    const fields: [string, string][] = [['number', card.number], ['expiryDate', card.expiry], ['securityCode', card.cvv]];
    const normalize = (value?: string) => (value ?? '').replace(/\D/g, '');
    for (let pass = 0; pass < 5; pass++) {
      // The checkout may open on a saved-card view; switch to the new-card view
      // so the secure input fields exist (whichever control this build renders).
      await driver.sendTop({ type: 'driver.newCardView' }).catch(() => undefined);
      const framesReady = await this.waitForHasThreeFields(driver, pass === 0 ? 25_000 : 12_000);
      if (!framesReady) {
        if (await this.valuesPersisted(driver, fields, normalize).catch(() => false)) { this.filled = true; return; }
        if (pass < 4) { await sleep(500); continue; }
        console.error('[duke] card fill: secure frames did not appear');
        throw new AppError('CARD_FIELDS', 'The secure card fields did not appear in time. Reload the BIG W checkout and prepare again.');
      }
      let filledThisPass = true;
      for (const [type, value] of fields) {
        if (!(await this.fillField(driver, type, value))) { filledThisPass = false; break; }
      }
      // Let the checkout finish re-creating any fields, then confirm the values stuck.
      if (filledThisPass) {
        await sleep(1200);
        if (await this.valuesPersisted(driver, fields, normalize)) {
          if (opts?.programmaticSubmit) {
            // Purchase mode submits right away: the submit step re-fills and
            // re-clicks Pay until the retailer confirms the request.
            this.filled = true;
            return;
          }
          // Assist mode leaves the submission to the user, so keep re-filling
          // for a short window so the card is genuinely still in the fields.
          const until = Date.now() + 3000;
          while (Date.now() < until) {
            await sleep(700);
            if (await this.valuesPersisted(driver, fields, normalize)) continue;
            console.log('[duke] card fill: secure fields rebuilt again; re-filling');
            let refilled = true;
            for (const [type, value] of fields) if (!(await this.fillField(driver, type, value))) { refilled = false; break; }
            if (!refilled) break;
          }
          this.filled = true;
          return;
        }
      }
      console.log(`[duke] card fill: checkout rebuilt the secure fields (pass ${pass + 1}); filling again`);
      await sleep(400);
    }
    throw new AppError('CARD_FIELDS', 'The BIG W checkout kept rebuilding the card fields. Prepare a fresh run and try again.', 400);
  }

  // Port of PaymentDriver.submit(). The observed request entries are the
  // authoritative record; the MAIN-world guard's events are advisory.
  async pay(prepared: PreparedCheckout, card: PaymentInput, onActionRequired: () => void, signal?: AbortSignal): Promise<PaymentOutcome> {
    const handle = await this.acquire();
    const driver = this.driverOf(handle);
    if (signal) checkAbort(signal);
    // The MAIN-world observer's ring buffer outlives a run; drop it so a stale
    // entry from a previous attempt cannot settle this submission.
    await driver.observeClear?.().catch(() => undefined);
    return new Promise<PaymentOutcome>(resolve => {
      // `observed` records an observed payment response (the authoritative
      // outcome source); `submitted` records that a submission was actually
      // initiated. The server's PaymentGuard.onSent sets `observed` when the
      // request is *sent*; the extension can only see the response, so it tracks
      // the dispatch point separately (a Pay click, or the issued /pay call).
      let settled = false, observed = false, submitted = false, guardEnabled = false, requestedAction = false, checkingObserve = false, checkingState = false;
      let pendingReference: string | undefined;
      const unknown: PaymentOutcome = { status: 'unknown', message: 'The payment outcome is not confirmed. Check BIG W order history before another purchase.' };
      const finish = (outcome: PaymentOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline); clearTimeout(vaultDeadline); clearInterval(observePoll); clearInterval(statePoll);
        // Only release a gate this run actually opened (server: this.gate?.close()).
        if (guardEnabled) void driver.guardDisable().catch(() => undefined);
        resolve(outcome);
      };
      const action = () => { if (!requestedAction) { requestedAction = true; onActionRequired(); } };

      // The observer polls every 700 ms, mirroring the server's page poll. The
      // server's response/requestfailed listeners become observed entries:
      // a vault 4xx fails fast, a payment 2xx is interpreted, and a payment
      // entry with status 0 is the requestfailed path.
      const observePoll = setInterval(() => {
        if (settled || checkingObserve) return;
        checkingObserve = true;
        void (async () => {
          try {
            const result = await driver.observe();
            for (const entry of result.entries) {
              if (settled) return;
              if (entry.method !== 'POST') continue;
              if (isVaultEndpoint(entry.url) && entry.status >= 400) {
                finish({ status: 'declined', message: 'The secure card step failed before BIG W received a payment (the payment session may have expired). Prepare a fresh run and try again.' });
                return;
              }
              if (!isPaymentEndpoint(entry.url, prepared.cartId)) continue;
              if (entry.status === 0) { finish(unknown); return; }
              if (entry.status >= 200) {
                observed = true;
                let value: unknown;
                try { value = JSON.parse(entry.bodyText); } catch { value = undefined; }
                const body = record(record(value).data ?? value);
                pendingReference = orderReference(body) ?? pendingReference;
                const outcome = interpretPaymentResult(value, entry.status);
                if (outcome) { finish(outcome); return; }
              }
            }
          } catch { /* observation is best-effort; retry on the next tick */ }
          finally { checkingObserve = false; }
        })();
      }, 700);

      const statePoll = setInterval(() => {
        if (settled || checkingState) return;
        checkingState = true;
        void (async () => {
          try {
            const result = await driver.sendTop({ type: 'driver.state' }) as { url?: string; challenge?: boolean; confirmed?: boolean } | undefined;
            if (settled) return;
            const url = new URL(String(result?.url ?? 'about:blank'));
            if (result?.challenge || (observed && url.protocol === 'https:' && url.hostname !== 'www.bigw.com.au')) action();
            if (observed && result?.confirmed && url.origin === 'https://www.bigw.com.au' && url.pathname.includes('/checkout/confirmation') && pendingReference) {
              finish({ status: 'confirmed', orderNumber: pendingReference });
            }
          } catch { /* navigation; retry */ }
          finally { checkingState = false; }
        })();
      }, 700);

      const deadline = setTimeout(() => finish(unknown), 300_000);
      // Server equivalent: PaymentGuard.onSent. Only fail after 20 s if nothing
      // was ever submitted; once a submission has been sent, a slow response
      // must not settle as unknown.
      const vaultDeadline = setTimeout(() => { if (!submitted) finish(unknown); }, 20_000);

      void (async () => {
        try {
          const binding: PaymentBinding = { cartId: prepared.cartId, cartVersion: prepared.cart.version, totalCents: prepared.cart.total, kind: card.kind };
          if (card.kind === 'new') {
            const frame = await this.frameOfType(driver, 'number');
            binding.sessionId = frame ? new URL(frame.url).searchParams.get('sessionId') ?? undefined : undefined;
            if (!binding.sessionId || binding.sessionId === 'undefined') {
              finish({ status: 'blocked', code: 'CARD_SESSION', message: 'The secure payment session is not ready. No payment was submitted.' }); return;
            }
          } else { binding.savedCardId = card.cardId; binding.securityCode = card.cvv; }
          await driver.guardEnable(binding);
          guardEnabled = true;
          if (card.kind === 'new') {
            const fields: [string, string][] = [['number', card.number], ['expiryDate', card.expiry], ['securityCode', card.cvv]];
            const normalize = (value?: string) => (value ?? '').replace(/\D/g, '');
            // The checkout rebuilds the secure fields shortly after fill, which
            // clears the card and turns a Pay click into a silent no-op. Keep
            // re-filling and clicking until a payment request is observed. The
            // guard allows only the first submission, so re-clicking is safe.
            // Stop once a Pay click has been dispatched (server:
            // PaymentGuard.onSent) — a slow response must not settle unknown.
            for (let attempt = 0; attempt < 6 && !settled && !observed && !submitted; attempt++) {
              if (!(await this.valuesPersisted(driver, fields, normalize))) {
                try { await this.fillCard(card); } catch { /* fill logs its own reason */ }
              }
              if (settled || observed || submitted) break;
              const click = await driver.sendTop({ type: 'driver.clickPay' }).catch(() => undefined) as { clicked?: boolean } | undefined;
              if (click?.clicked === true) submitted = true;
              const until = Date.now() + 4000;
              while (Date.now() < until && !settled && !observed && !submitted) await sleep(200);
              if (!settled && !observed && !submitted) console.log(`[duke] card submit: no payment seen after click ${attempt + 1}; retrying`);
            }
            if (!observed && !submitted && !settled) finish(unknown);
          } else {
            const fingerprint = (await driver.antiFraud()).fingerprint;
            // Issuing the stored-card /pay request is this path's submission
            // point (server: PaymentGuard.onSent on the intercepted request).
            submitted = true;
            const value = await this.req(handle, `/storefront/v1/cart/${encodeURIComponent(prepared.cartId)}/pay`, 'POST', {
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
              await driver.navigate(url.href);
            }
          }
        } catch { finish(unknown); }
      })();
    });
  }

  // Port of BigWAdapter.startAfterpay(): the content driver selects Afterpay
  // and re-clicks its (lazily mounted) button; a content script cannot observe
  // the hand-off, so report whether a click was performed.
  async startAfterpay(): Promise<boolean> {
    const handle = await this.acquire();
    const driver = this.driverOf(handle);
    await driver.activate();
    const result = await driver.sendTop({ type: 'driver.clickAfterpay' }).catch(() => undefined) as { clicked?: boolean } | undefined;
    return result?.clicked === true;
  }

  // Port of PaymentDriver.clear(): wipe the secure fields only if a fill
  // happened, so a stray clear cannot fire events on an untouched form.
  async clearSensitiveFields(): Promise<void> {
    if (!this.filled) return;
    this.filled = false;
    const handle = await this.acquire().catch(() => undefined);
    if (!handle?.driver) return;
    const driver = handle.driver;
    for (const type of ['number', 'expiryDate', 'securityCode']) {
      try {
        const frame = await this.frameOfType(driver, type);
        if (frame) await driver.sendFrame(frame.frameId, { type: 'driver.field.clear' });
      } catch { /* The provider may already have navigated away. */ }
    }
  }

  // The MAIN-world guard is the gate (released explicitly via guardDisable), so
  // there is no persistent gate to release here — only the fill flag resets.
  async resetAfterNavigation(): Promise<void> {
    this.filled = false;
  }
}
