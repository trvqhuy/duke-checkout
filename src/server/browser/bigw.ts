import type { Page } from 'puppeteer-core';
import type { Address, ArmedCheckout, CartState, PaymentInput, PreparedCheckout, Profile, ProductInfo, RunRequest, SavedCard, StageReporter, StoreAdapter } from '../../shared/types.ts';
import { parseProductLink } from '../../shared/validation.ts';
import { AppError, checkAbort } from '../errors.ts';
import { BrowserConnection, PREP_ORIGIN } from './connection.ts';
import { buildProductInfo, parseCartState, record, string } from './bigw-model.ts';
import { TrafficPolicy } from './blocklist.ts';
import { APPLY_CART_CONTEXT, PAGE_CONTEXT, PAGE_REQUEST } from './page-api.ts';
import { PaymentDriver } from './payment.ts';

interface Context { authenticated: boolean; tokenSecondsRemaining: number; cartId: string | null; storeId: string | null; delivery: Record<string, unknown> | null }
interface ApiResult { ok: boolean; status: number; data?: unknown; code?: string }

const TOKEN_MIN_SECONDS = 120;
// Failure codes that mean "the retailer is not accepting this product yet" —
// the pre-release case. Arming downgrades to a standby instead of failing.
const STANDBY_CODES = ['UNAVAILABLE', 'STORE_REQUEST', 'REQUEST_NETWORK', 'REQUEST_TIMEOUT', 'CART_INVALID'];

export class BigWAdapter implements StoreAdapter {
  private activePage?: Page;
  private watchedPage?: Page;
  private payment?: PaymentDriver;
  private location?: { storeId: string; zone?: string; zoneType?: string };
  private refreshUrl = 'https://www.bigw.com.au/';
  private armed?: ArmedCheckout;
  private readonly policies = new WeakMap<Page, TrafficPolicy>();
  constructor(public readonly connection: Pick<BrowserConnection, 'state' | 'connect' | 'page'>) {}

  private async context(page: Page): Promise<Context> { return page.evaluate(`(${PAGE_CONTEXT})()`) as Promise<Context>; }

  private async livePage(): Promise<Page> {
    if (this.activePage && !this.activePage.isClosed() && this.activePage.url().startsWith('https://www.bigw.com.au/')) return this.activePage;
    return this.session();
  }

  private async policyFor(page: Page): Promise<void> {
    let policy = this.policies.get(page);
    if (!policy) { policy = new TrafficPolicy(page); this.policies.set(page, policy); }
    await policy.install();
  }

  // Fetch the checkout route's own HTML and pull every same-origin static asset
  // it references into the HTTP cache. Runs in the background while the cart is
  // prepared; measured to remove most of the network time from the final reveal.
  private async warmCheckout(): Promise<void> {
    const page = this.activePage;
    if (!page || page.isClosed()) return;
    try {
      await page.evaluate(`(async () => {
        if (window.__dukeWarm) return;
        window.__dukeWarm = true;
        let html;
        try { const response = await fetch('/checkout/delivery', { credentials: 'same-origin' }); if (!response.ok) return; html = await response.text(); } catch { return; }
        const urls = new Set();
        for (const match of html.matchAll(/["'(](\/_next\/static\/[^"')]+)["')]/g)) urls.add(match[1]);
        await Promise.allSettled(Array.from(urls).slice(0, 200).map(url => fetch(url, { credentials: 'same-origin' })));
      })()`);
    } catch { /* Cache warming is optional; a failure must never affect a run. */ }
  }

  // Prepare from the lightweight same-origin document (cheap, no app or analytics
  // requests). Only when the session token is stale do we load a real BIG W page,
  // because only the site's own SDK can silently renew the token.
  private async session(): Promise<Page> {
    const page = await this.connection.page();
    await this.policyFor(page);
    let context = await this.context(page);
    if (!context.authenticated || context.tokenSecondsRemaining < TOKEN_MIN_SECONDS) {
      if (this.activePage === page) await this.payment?.resetAfterNavigation();
      await page.goto(this.refreshUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      try { await page.waitForFunction(`(${PAGE_CONTEXT})().authenticated && (${PAGE_CONTEXT})().tokenSecondsRemaining > ${TOKEN_MIN_SECONDS}`, { timeout: 25_000, polling: 250 }); }
      catch { throw new AppError('LOGIN_REQUIRED', 'Sign in to BIG W in the existing Chrome tab, then try again.'); }
      context = await this.context(page);
    } else if (!/^(https:\/\/www\.bigw\.com\.au\/)/.test(page.url() || '')) {
      // Token is fresh: keep a live BIG W page where it is (its API requests work
      // from any BIG W origin and it keeps the session warm), but return a stray
      // tab to the quiet origin so preparation loads no app code.
      await page.goto(PREP_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
    }
    if (!context.authenticated) throw new AppError('LOGIN_REQUIRED', 'Sign in to BIG W in the existing Chrome tab.');
    if (this.activePage !== page || !this.payment) this.payment = new PaymentDriver(page, (path, method, body) => this.request(path, method, body));
    if (this.watchedPage !== page && process.env.DUKE_DEBUG) {
      this.watchedPage = page;
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log(`[duke-nav] +${Date.now()} ${frame.url().slice(0, 90)}`); });
      page.on('request', request => { if (request.isNavigationRequest()) console.log(`[duke-navreq] +${Date.now()} ${request.method()} ${request.url().slice(0, 80)} redirects=${request.redirectChain().length} type=${request.resourceType()}`); });
    }
    this.activePage = page;
    return page;
  }

  async connect() {
    await this.connection.connect();
    // Attach and prepare the background working tab only. Session renewal and
    // navigation are deferred to the first real step so a connect click stays cheap.
    const page = await this.connection.page();
    await this.policyFor(page);
    this.activePage = page;
    return this.connection.state;
  }

  private async request(path: string, method = 'GET', body?: unknown, origin = 'https://api.bigw.com.au', publicRequest = false, attempt = 0): Promise<unknown> {
    const page = await this.livePage();
    const t0 = Date.now();
    let result: ApiResult;
    try {
      result = await page.evaluate(`(${PAGE_REQUEST})(${JSON.stringify({ origin, path, method, body, publicRequest })})`) as ApiResult;
    } catch (error) {
      console.error(`[duke] store evaluate failed path=${path.split('?')[0]} closed=${page.isClosed()}`);
      throw error;
    }
    console.log(`[duke] api ${Date.now() - t0}ms ${method} ${path.split('?')[0]}`);
    if (!result.ok) {
      // A 403 on an authenticated call is almost always the retailer's anti-bot
      // sensor going stale (its cookie only refreshes on a real page load). While
      // the checkout is not open yet, reload the product page once so the sensor
      // renews, then retry the same request.
      if (result.status === 403 && attempt < 1) {
        let current = '';
        try { current = page.url(); } catch { /* ignore */ }
        if (!/\/checkout\//.test(current)) {
          console.log(`[duke] ${method} ${path.split('?')[0]} returned 403; reloading a BIG W page to renew the anti-bot session, then retrying`);
          await page.goto(this.refreshUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
          await page.waitForFunction(`(${PAGE_CONTEXT})().authenticated`, { timeout: 20_000, polling: 250 }).catch(() => undefined);
          // Give the page's anti-bot sensor a moment to beacon before retrying.
          await new Promise(resolve => setTimeout(resolve, 2_500));
          return this.request(path, method, body, origin, publicRequest, attempt + 1);
        }
      }
      const transient = method === 'GET' && ['REQUEST_NETWORK', 'REQUEST_TIMEOUT'].includes(result.code ?? '') && attempt < 2;
      console.error(`[duke] store request path=${path.split('?')[0]} method=${method} code=${result.code} status=${result.status} attempt=${attempt} retrying=${transient}`);
      if (transient) {
        await new Promise(resolve => setTimeout(resolve, 500 + attempt * 500));
        return this.request(path, method, body, origin, publicRequest, attempt + 1);
      }
      const messages: Record<string, string> = {
        LOGIN_REQUIRED: 'BIG W needs you to sign in again in the existing Chrome tab.',
        SESSION_EXPIRED: 'The BIG W session expired. Prepare a new run so the site can refresh its session.',
        BROWSER_ATTENTION: 'BIG W needs attention in Chrome. Complete any sign-in or browser check there, then prepare again.',
        REQUEST_TIMEOUT: 'BIG W took too long to respond to this preparation step.',
        REQUEST_NETWORK: 'The browser could not reach BIG W. Check its connection and try preparation again.',
      };
      throw new AppError(result.code ?? 'STORE_REQUEST', messages[result.code ?? ''] ?? `BIG W rejected the ${path.includes('billing-address') ? 'billing address' : path.includes('update-details') ? 'contact or delivery details' : 'checkout preparation'} request (HTTP ${result.status}). Check the BIG W tab.`, result.status >= 500 ? 502 : 400);
    }
    return result.data;
  }

  private async locationFor(profile: Profile): Promise<{ storeId: string; zone?: string; zoneType?: string }> {
    const page = await this.livePage();
    const context = await this.context(page);
    const address = profile.deliveryAddress;
    const zones = await this.request(`/warehouse-customer/v1/postcode/${encodeURIComponent(address.postcode)}?suburb=${encodeURIComponent(address.suburb.toUpperCase())}`, 'GET', undefined, 'https://api.bigw.com.au', true);
    const zone = record(Array.isArray(zones) ? zones[0] : zones);
    if (zone.state && zone.state !== address.state) throw new AppError('ADDRESS_LOCATION', 'The suburb/postcode does not match the selected state. Check the delivery address.');
    let storeId = typeof context.storeId === 'string' ? context.storeId : '';
    if (!storeId) {
      const data = await this.request('/api/stores/v0/list', 'GET', undefined, 'https://api.bigw.com.au', true);
      const stores = Array.isArray(data) ? data : record(data).stores;
      const store = Array.isArray(stores) ? stores.find(item => string(record(record(item).address).state) === address.state) ?? stores[0] : undefined;
      storeId = string(record(store).id, string(record(store).name));
    }
    if (!storeId) throw new AppError('STORE_REQUIRED', 'Choose a local store once on BIG W, then prepare again.');
    return { storeId, zone: string(zone.miraklZone) || undefined, zoneType: string(zone.zoneClassification) || undefined };
  }

  async inspect(productUrl: string, profile: Profile): Promise<ProductInfo> {
    const { code, url } = parseProductLink(productUrl);
    // If the session needs renewing, load this product's own page: it is a real
    // BIG W app page, so the SDK can refresh silently, and it gives product calls
    // a natural referer.
    this.refreshUrl = url;
    await this.session();
    // Warm the browser cache for the checkout route while the API work below
    // runs, so the single visible navigation at the end is near-instant. This is
    // best-effort and never blocks preparation.
    void this.warmCheckout();
    // The postcode lookup, product details, and price lookups are independent,
    // so run them together; only the availability call needs the resolved store.
    const [location, products, prices] = await Promise.all([
      this.locationFor(profile),
      this.request(`/apim/product-price-api/v1/products?productCodes=${code}`, 'GET', undefined, 'https://apix.bigw.com.au', true),
      this.request(`/apim/product-price-api/v1/prices/${code}?state=${profile.deliveryAddress.state}`, 'GET', undefined, 'https://apix.bigw.com.au', true),
    ]);
    this.location = location;
    const query = new URLSearchParams({ storeId: location.storeId, deliveryPostcode: profile.deliveryAddress.postcode, deliverySuburb: profile.deliveryAddress.suburb.toUpperCase() });
    // BIG W's standalone availability endpoint intermittently rejects requests
    // (ERR_HTTP2_PROTOCOL_ERROR) and its internal retries can stall the whole
    // inspection. It is advisory: the cart's own fulfilment response is
    // authoritative, so give it a short budget and otherwise proceed without it.
    let availability: unknown = null;
    try {
      availability = await Promise.race([
        this.request(`/api/availability/v0/product/${code}?${query}`, 'GET', undefined, 'https://api.bigw.com.au', true),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2_000)),
      ]);
    } catch (error) {
      if (!(error instanceof AppError) || !['REQUEST_NETWORK', 'REQUEST_TIMEOUT'].includes(error.code)) throw error;
      console.warn(`[duke] availability lookup unavailable; deferring to cart fulfilment code=${code}`);
    }
    return buildProductInfo(url, products, prices, availability);
  }

  private apiAddress(address: Address, profile: Profile): Record<string, unknown> {
    return { ...address, suburb: address.suburb.toUpperCase(), firstName: profile.firstName, lastName: profile.lastName, phonenumber: profile.phone, businessName: '' };
  }

  // Everything cart-related that can happen without touching the visible page:
  // create/reuse the cart, set fulfilment, contact, billing, recalculate, and
  // publish the cart id into the page's local state. Used by both a normal run
  // and by arm-ahead-of-time preparation.
  private async prepareCart(input: RunRequest, product: ProductInfo, report: StageReporter, signal: AbortSignal): Promise<PreparedCheckout> {
    const page = await this.livePage();
    const context = await this.context(page);
    const location = this.location ?? await this.locationFor(input.profile);
    const address = input.profile.deliveryAddress;
    report('cart', 'Preparing a cart containing only the requested item.');
    let cart: CartState | undefined;
    if (context.cartId) {
      try {
        const existing = parseCartState(await this.request(`/storefront/v1/cart/${encodeURIComponent(context.cartId)}?state=${address.state}&channel=web`));
        if (existing.entries.length === 1 && existing.entries[0].productCode === product.code && existing.entries[0].quantity === input.quantity) cart = existing;
      } catch (error) { if (!(error instanceof AppError) || ['LOGIN_REQUIRED', 'SESSION_EXPIRED', 'BROWSER_ATTENTION'].includes(error.code)) throw error; }
    }
    checkAbort(signal);
    if (!cart) {
      cart = parseCartState(await this.request('/storefront/v1/cart/create', 'POST', {
        storeId: location.storeId, postcode: address.postcode, suburb: address.suburb.toUpperCase(), state: address.state,
        productCode: product.code, quantity: input.quantity, salesChannel: 'website',
      }));
    }
    if (!cart.id.startsWith('CT_')) throw new AppError('CHECKOUT_VERSION', 'This session returned a different BIG W checkout implementation. Preparation stopped before payment.');
    const id = encodeURIComponent(cart.id);
    // The three cart detail updates are independent of each other; only the
    // recalculation must run after all of them. They start together with a small
    // stagger so the retailer's edge does not see an identical-millisecond burst.
    report('contact', 'Applying validated delivery and billing details.');
    const mutations: Array<[number, () => Promise<unknown>]> = [
      [0, () => this.request(`/storefront/v1/cart/${id}/update-details?channel=web`, 'POST', {
        firstName: input.profile.firstName, lastName: input.profile.lastName, phone: input.profile.phone,
        authorityToLeave: false, deliveryAddress: this.apiAddress(address, input.profile), orderType: 'DELIVERY', fulfilmentType: 'DELIVERY',
      })],
      [120, () => this.request(`/storefront/v1/cart/${id}/fulfilment-preference?channel=web`, 'POST', {
        postcode: address.postcode, suburb: address.suburb.toUpperCase(), state: address.state,
        pickupStore: location.storeId, pickupStoresNearby: [location.storeId],
      })],
      [240, () => this.request(`/storefront/v1/cart/${id}/billing-address?channel=web`, 'POST', this.apiAddress(input.profile.billingSame ? address : input.profile.billingAddress!, input.profile))],
    ];
    await Promise.all(mutations.map(([delay, call]) => new Promise((resolve, reject) => setTimeout(() => call().then(resolve, reject), delay))));
    checkAbort(signal);
    await this.request(`/storefront/v1/cart/${id}/recalculate?channel=web`, 'POST', {
      salesChannel: 'website', suburb: address.suburb.toUpperCase(), state: address.state,
      postcode: address.postcode, storeId: location.storeId, pickupStoresNearby: [location.storeId],
    });
    checkAbort(signal);
    await page.evaluate(`(${APPLY_CART_CONTEXT})(${JSON.stringify({ address, cartId: cart.id, ...location })})`);
    return { cartId: cart.id, cart, product };
  }

  // Bring the prepared checkout on screen. Only a caller that has not mutated
  // the cart since the page loaded may reuse the mounted page (the armed fast
  // path); a fresh preparation must reload so the page reflects the new cart.
  async revealPrepared(prepared: PreparedCheckout, report: StageReporter, signal: AbortSignal, opts?: { reuseMountedPage?: boolean }): Promise<void> {
    const page = await this.livePage();
    const onCheckout = /\/checkout\//.test(page.url() || '');
    if (onCheckout && opts?.reuseMountedPage && this.payment) {
      report('payment', 'The armed checkout is already open — confirming its secure fields.');
      await this.payment.ready(signal);
      return;
    }
    report('payment', 'Opening the prepared checkout.');
    const driver = this.payment;
    if (!driver) throw new AppError('BROWSER_ATTENTION', 'The BIG W session is not ready. Connect and prepare again.');
    const navigation = page.goto('https://www.bigw.com.au/checkout/delivery', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.bringToFront().catch(() => undefined);
    await navigation;
    await driver.resetAfterNavigation();
    await driver.ready(signal);
  }

  async prepare(input: RunRequest, product: ProductInfo, report: StageReporter, signal: AbortSignal): Promise<PreparedCheckout> {
    const prepared = await this.prepareCart(input, product, report, signal);
    await this.revealPrepared(prepared, report, signal);
    return prepared;
  }

  // Arm ahead of time: run every preparation step that does not need the user
  // watching, then leave the checkout page loaded (in the background) with its
  // secure fields mounting. A later matching run skips straight to the payment.
  // Pre-release products that cannot enter a cart yet arm as 'standby' instead:
  // session, product details, and page warm-up are ready, and the run adds the
  // cart itself at the release moment.
  async arm(input: RunRequest, report: StageReporter, signal: AbortSignal): Promise<ArmedCheckout> {
    const { url } = parseProductLink(input.productUrl);
    this.refreshUrl = url;
    await this.session();
    void this.warmCheckout();
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
    // Preload the checkout in the background so the secure fields are already
    // mounted (or mounting) when the purchase moment arrives. Best-effort: a
    // run re-checks everything and can open the page itself.
    try {
      const page = await this.livePage();
      const navigation = page.goto('https://www.bigw.com.au/checkout/delivery', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await navigation;
      await this.payment!.resetAfterNavigation();
      void this.payment!.ready(signal).catch(() => undefined);
    } catch { /* The run re-opens the page if the preload fails. */ }
    this.armed = {
      productUrl: input.productUrl, productCode: product.code, quantity: input.quantity,
      maxTotalCents: input.maxTotalCents, profile: input.profile, product,
      cartId: prepared.cartId, cart: prepared.cart, armedAt: new Date().toISOString(),
      level: 'cart-ready',
    };
    console.log(`[duke] armed cart ${prepared.cartId} for ${product.code} (total ${(prepared.cart.total / 100).toFixed(2)})`);
    return this.armed;
  }

  // A standby arm for pre-release products: nothing cart-related is possible
  // yet, but the session token, cached product/location details, and a warmed
  // checkout page remove every other delay from the release-moment run.
  private standbyArm(input: RunRequest, product: ProductInfo, note: string): ArmedCheckout {
    void this.warmCheckout();
    // Warm the checkout page itself (app bundles, fonts) even though its cart
    // is empty; the release-moment navigation then reuses the warm cache.
    void (async () => {
      try {
        const page = await this.livePage();
        await page.goto('https://www.bigw.com.au/checkout/delivery', { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await this.payment?.resetAfterNavigation();
      } catch { /* optional warm-up only */ }
    })();
    this.armed = {
      productUrl: input.productUrl, productCode: product.code, quantity: input.quantity,
      maxTotalCents: input.maxTotalCents, profile: input.profile, product,
      cartId: '', cart: { id: '', version: 0, total: 0, deliveryCost: 0, entries: [] },
      armedAt: new Date().toISOString(), level: 'standby', note,
    };
    console.log(`[duke] armed standby for ${product.code}: ${note}`);
    return this.armed;
  }

  armedState(): ArmedCheckout | null { return this.armed ?? null; }

  disarm(): void { this.armed = undefined; }

  // Standby keeper: reload a real BIG W page before the session token expires
  // so an armed checkout stays usable for hours. Reloading the checkout page
  // itself keeps its assets warm; any other BIG W page refreshes the token too.
  async keepSessionFresh(): Promise<void> {
    if (this.connection.state.status !== 'connected') return;
    let page: Page;
    try { page = await this.connection.page(); } catch { return; }
    let context: { authenticated: boolean; tokenSecondsRemaining: number };
    try { context = await this.context(page); } catch { return; }
    if (!context.authenticated || context.tokenSecondsRemaining > 240) return;
    const current = page.url() || '';
    const target = /^https:\/\/www\.bigw\.com\.au\/(?!robots\.txt)./.test(current) ? current : this.refreshUrl;
    console.log(`[duke] refreshing the BIG W session early via ${new URL(target).pathname}`);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForFunction(`(${PAGE_CONTEXT})().authenticated`, { timeout: 20_000, polling: 250 }).catch(() => undefined);
  }

  async verify(prepared: PreparedCheckout, input: RunRequest): Promise<CartState> {
    const page = await this.livePage();
    const context = await this.context(page);
    if (context.cartId !== prepared.cartId) throw new AppError('CART_CHANGED', 'The active BIG W cart changed during this run. Preparation stopped before payment.');
    return parseCartState(await this.request(`/storefront/v1/cart/${encodeURIComponent(prepared.cartId)}?state=${input.profile.deliveryAddress.state}&channel=web`));
  }

  async importProfile(): Promise<{ profile: Profile; savedCards: SavedCard[] }> {
    const page = await this.session();
    const context = await this.context(page);
    const [addressesData, accountData, cartData, cards] = await Promise.all([
      this.request('/profile/v1/addresses'), this.request('/profile/v1/profile'),
      context.cartId ? this.request(`/storefront/v1/cart/${encodeURIComponent(context.cartId)}?channel=web`) : Promise.resolve(null),
      this.savedCards(),
    ]);
    const cart = record(cartData), account = record(accountData);
    const addresses = Array.isArray(addressesData) ? addressesData : [];
    const address = record(cart.deliveryAddress ?? addresses.find(item => record(item).primary === true) ?? addresses[0]);
    const customer = record(cart.customer);
    const name = record(account.name), phone = record(account.phone);
    const normalize = (value: Record<string, unknown>): Address => ({
      line1: string(value.line1), line2: string(value.line2), suburb: string(value.suburb, string(value.town)),
      postcode: string(value.postcode), state: string(value.state).replace('AU-', '') || string(context.delivery?.state), country: 'AU',
    });
    return { profile: {
      name: 'BIG W delivery', firstName: string(customer.firstName, string(address.firstName, string(name.given))),
      lastName: string(customer.lastName, string(address.lastName, string(name.family))),
      phone: string(customer.phone, string(address.phonenumber, string(phone.mobile))),
      deliveryAddress: normalize(address), billingSame: true,
    }, savedCards: cards };
  }

  async savedCards(): Promise<SavedCard[]> {
    const data = await this.request('/storefront/v1/cart/saved-cards');
    if (!Array.isArray(data)) return [];
    return data.map(value => { const card = record(value); return {
      id: string(card.id), brand: string(card.brand, 'Card'), last4: string(card.last4),
      expiryMonth: typeof card.expiryMonth === 'number' ? card.expiryMonth : undefined,
      expiryYear: typeof card.expiryYear === 'number' ? card.expiryYear : undefined,
    }; }).filter(card => card.id && /^\d{4}$/.test(card.last4));
  }

  async listCards(): Promise<SavedCard[]> { await this.session(); return this.savedCards(); }
  async focus(): Promise<void> {
    // Resolve a live tab first: a stale reference to a closed page would throw.
    const page = await this.connection.page();
    this.activePage = page;
    await page.bringToFront();
  }

  async fillCard(card: PaymentInput, opts?: { programmaticSubmit?: boolean }): Promise<void> { await this.payment!.fill(card, opts); }

  // Select the Afterpay payment option and press its button, which starts
  // Afterpay's own flow (a redirect or popup) for the user to complete. Returns
  // whether the hand-off was detected. The button is re-clicked a few times
  // because the Afterpay SDK loads lazily and an early click can no-op.
  async startAfterpay(): Promise<boolean> {
    const page = await this.livePage();
    const hasAfterpayButton = `Array.from(document.querySelectorAll('button')).some(node => /with afterpay/i.test(node.textContent || ''))`;
    const selectAfterpay = `(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"], [role="radio"], label'));
      const tab = tabs.find(node => /afterpay/i.test(node.textContent || ''));
      if (!tab) return false;
      const target = tab.querySelector('input[type="radio"]') || tab.querySelector('[role="radio"]') || tab.querySelector('.option-toggle') || tab;
      target.click();
      return true;
    })()`;
    const clickPay = `(() => {
      const button = Array.from(document.querySelectorAll('button')).find(node => /with afterpay/i.test(node.textContent || ''));
      if (button && !button.disabled) { button.click(); return true; }
      return false;
    })()`;
    const handedOff = async (): Promise<boolean> => {
      if (!page.url().startsWith('https://www.bigw.com.au/')) return true;
      if (await page.evaluate(`!!document.querySelector('iframe[src*="afterpay" i], iframe[src*="clearpay" i]')`).catch(() => false)) return true;
      const popup = page.browser().pages().then(pages => pages.find(candidate => /afterpay|clearpay/i.test(candidate.url())));
      const found = await popup;
      if (found) { await found.bringToFront().catch(() => undefined); return true; }
      return false;
    };
    for (let select = 0; select < 25; select++) {
      await page.evaluate(selectAfterpay);
      if (await page.evaluate(hasAfterpayButton)) break;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (!(await page.evaluate(hasAfterpayButton))) {
      throw new AppError('AFTERPAY_UNAVAILABLE', 'Could not select Afterpay on the BIG W checkout. Check the checkout tab, then try again.');
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.evaluate(clickPay);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (await handedOff()) return true;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    return false;
  }

  async pay(prepared: PreparedCheckout, card: PaymentInput, onActionRequired: () => void) { return this.payment!.submit(prepared, card, onActionRequired); }
  async clearSensitiveFields(): Promise<void> { await this.payment?.clear(); }
}
