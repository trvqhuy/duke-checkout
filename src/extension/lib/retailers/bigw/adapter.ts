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
// (m) armedState()/disarm() expose the RunManager's armed fast paths with no
//     chrome dependency: an optional armedStore is injected by the service
//     worker (backed by chrome.storage.session), and arm()/standbyArm()
//     publish the produced ArmedCheckout into it as well as returning it. The
//     accessors are synchronous, exactly as the ported RunManager calls them
//     (`this.adapter.armedState?.()` / `disarm?.()`).
// The bridge reads the live token per request, so no session renewal step
// exists here.
import { parseProductLink } from '../../../../shared/validation.ts';
import { STANDBY_CODES } from '../../../../shared/armed.ts';
import { buildProductInfo, parseCartState, record, string } from '../../../../server/browser/bigw-model.ts';
import { isPaymentEndpoint, isVaultEndpoint, interpretPaymentResult } from '../../../../server/browser/payment.ts';
import { AppError, checkAbort } from '../../../../server/errors.ts';
import { guardCart } from '../../../../shared/cart-guard.ts';
import { bridgeRequest } from '../../../background/bridge-client.ts';
import { scopesForPath } from '../../../content/api-bridge-main.ts';
import type { BridgeHandle, DriverFrame, DriverHandle, RetailerAdapter } from '../types.ts';
import type { PaymentBinding } from '../../../../shared/payment-check.ts';
import type { Address, ArmedCheckout, CartState, PaymentInput, PaymentOutcome, PreparedCheckout, ProductInfo, Profile, RunRequest, SavedCard, StageReporter } from '../../../../shared/types.ts';

interface Location { storeId: string; zone?: string; zoneType?: string }

const SECURE_ORIGIN = 'https://secure-fields.wpay2.gr4vy.app';
const CHECKOUT_URL = 'https://www.bigw.com.au/checkout/delivery';
// Verbatim server copy (src/server/browser/payment.ts, PaymentGuard.onPrevented):
// the guard blocked a submission before it reached the network.
const BLOCKED_MESSAGE = 'The cart, total, or payment session changed before submission. The request was blocked; prepare a fresh run.';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Verbatim from src/server/browser/payment.ts (not exported there): a merchant
// order reference is a short word-ish string or number.
function orderReference(body: Record<string, unknown>): string | undefined {
  const value = body.orderNumber;
  return (typeof value === 'string' || typeof value === 'number') && /^[\w-]{3,80}$/.test(String(value)) ? String(value) : undefined;
}

// The live /api/stores/v0/list returns an OBJECT MAP keyed by store id
// ({"0130":{"id":"0130","name":"BIG W Carnes Hill","address":{...}},...}), while
// fixtures and older builds return an array or { stores: [...] }. The previous
// code only understood the array shapes, so the real response was read as "no
// stores" and every preparation ended at STORE_REQUIRED. Normalise all three.
export type StoreRecord = Record<string, unknown>;

function storeList(value: unknown): StoreRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => record(item))
    .filter(item => typeof item.id === 'string' || typeof item.name === 'string');
}

export function normalizeStores(value: unknown): StoreRecord[] {
  if (Array.isArray(value)) return storeList(value);
  const object = record(value);
  if (Array.isArray(object.stores)) return storeList(object.stores);
  // A plain object keyed by store id: every value is a store record. Filter out
  // any metadata keys that do not look like a store.
  return Object.values(object)
    .map(item => record(item))
    .filter(item => typeof item.id === 'string' || typeof item.name === 'string');
}

// Prefer a store in the delivery postcode, then the same state, then any store.
// Delivery availability and fulfilment are keyed by postcode/suburb, but a
// store in the same region keeps the retailer's own store-scoped data coherent.
export function pickStore(value: unknown, address: Pick<Address, 'postcode' | 'state'>): StoreRecord | undefined {
  const stores = normalizeStores(value);
  const postcode = String(address.postcode ?? '');
  return stores.find(store => String(record(store.address).postcode ?? '') === postcode)
    ?? stores.find(store => String(record(store.address).state ?? '') === address.state)
    ?? stores[0];
}

export class BigWExtensionAdapter implements RetailerAdapter {
  readonly urlPattern = /https:\/\/www\.bigw\.com\.au\/product\/[^/]+\/p\/(\d+)/;
  private location?: Location;
  // Set once a card fill persisted secure-field values; clearSensitiveFields()
  // only wipes when a fill actually happened (same gate as PaymentDriver.clear).
  private filled = false;
  // Presentation tab plumbing. The trigger opens progress.html before the run
  // and registers it here; the matching run replaces that tab with the real
  // checkout instead of opening a second one. requestId keeps a stale tab from
  // a failed run out of a later app-page run.
  private presentation?: { tabId: number; requestId: string };
  private runRequestId?: string;
  // The page context (store/cart ids) resolved during inspect, reused by
  // prepareCart so a run does not ask the bridge twice.
  private pageContextCache?: { storeId?: string; cartId?: string | null; delivery?: Record<string, unknown> | null } | null;
  // The checkout tab this run is driving. After revealPrepared, every
  // driver-backed step must stay on THIS tab; picking "a BIG W tab" again could
  // land on a stale checkout from an earlier run.
  private checkoutTabId?: number;
  constructor(private acquire: (pinnedTabId?: number) => Promise<BridgeHandle>, private armedStore?: { get(): ArmedCheckout | null; set(armed: ArmedCheckout | null): void }) {}

  // Called by the RunManager as a run starts. A presentation tab only applies to
  // the run it was opened for.
  beginRun(requestId: string): void {
    this.runRequestId = requestId;
    this.checkoutTabId = undefined;
    this.pageContextCache = undefined;
    if (this.presentation?.requestId !== requestId) this.presentation = undefined;
  }
  endRun(): void {
    this.runRequestId = undefined;
    this.checkoutTabId = undefined;
    this.presentation = undefined;
    this.pageContextCache = undefined;
  }
  setPresentationTab(tabId: number, requestId: string): void { this.presentation = { tabId, requestId }; }
  clearPresentationTab(): void { this.presentation = undefined; }

  // Every store call is bridged through the work tab. Authenticated calls carry
  // their required scopes so the MAIN world resolves a matching token.
  private async req(handle: BridgeHandle, path: string, method = 'GET', body?: unknown, origin = 'https://api.bigw.com.au', publicRequest = false): Promise<unknown> {
    const args = { origin, path, method, body, publicRequest, ...(publicRequest ? {} : { scopes: scopesForPath(path, method) }) };
    return bridgeRequest(handle.sender, handle.tabId, args);
  }

  // Synchronous armed-state accessors for the ported RunManager fast paths.
  // The store is injected by the service worker; a bare adapter (tests, other
  // hosts) simply reports no armed checkout.
  armedState(): ArmedCheckout | null { return this.armedStore?.get() ?? null; }
  disarm(): void { this.armedStore?.set(null); }

  // Public passthrough for the service worker's keeper: the same acquire seam
  // the adapter itself uses.
  acquirePublic(): Promise<BridgeHandle> { return this.acquire(); }

  // The server adapter read the page context (cookie store id, localStorage
  // cart id) directly; the extension asks the MAIN world for the same data over
  // the isolated relay's `bridge.context` message.
  private async pageContext(handle: BridgeHandle): Promise<{ storeId?: string; cartId?: string | null; delivery?: Record<string, unknown> | null } | null> {
    try {
      const reply = await Promise.race([
        handle.sender.sendMessage(handle.tabId, { type: 'bridge.context' }) as Promise<{ storeId?: string; cartId?: string | null; delivery?: Record<string, unknown> | null } | null>,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 5_000)),
      ]);
      return reply ?? null;
    } catch { return null; }
  }

  private async locationFor(handle: BridgeHandle, profile: Profile): Promise<Location> {
    const address = profile.deliveryAddress;
    const zones = await this.req(handle, `/warehouse-customer/v1/postcode/${encodeURIComponent(address.postcode)}?suburb=${encodeURIComponent(address.suburb.toUpperCase())}`, 'GET', undefined, 'https://api.bigw.com.au', true);
    const zone = record(Array.isArray(zones) ? zones[0] : zones);
    if (zone.state && zone.state !== address.state) throw new AppError('ADDRESS_LOCATION', 'The suburb/postcode does not match the selected state. Check the delivery address.');
    const context = await this.pageContext(handle);
    this.pageContextCache = context;
    let storeId = string(context?.storeId ?? '');
    if (!storeId) {
      const data = await this.req(handle, '/api/stores/v0/list', 'GET', undefined, 'https://api.bigw.com.au', true);
      const store = pickStore(data, address);
      storeId = string(store?.id, string(store?.name));
    }
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
    checkAbort(signal);
    // BIG W keeps ONE cart per signed-in account. The live site adds/updates
    // that cart instead of calling the legacy /cart/create endpoint (which the
    // edge now rejects with 403). Reuse it, replace its contents when needed,
    // and skip the detail mutations when the account cart already matches.
    const context = this.pageContextCache ?? await this.pageContext(handle);
    this.pageContextCache = context;
    let cart: CartState | undefined;
    let reused = false;
    if (context?.cartId) {
      try {
        cart = await this.readCart(handle, context.cartId, address.state);
        reused = true;
      } catch (error) {
        if (!(error instanceof AppError) || !['LOGIN_REQUIRED', 'SESSION_EXPIRED', 'BROWSER_ATTENTION', 'STORE_REQUEST'].includes(error.code)) throw error;
      }
    }
    checkAbort(signal);
    if (cart) {
      const exact = cart.entries.length === 1 && cart.entries[0].productCode === product.code && cart.entries[0].quantity === input.quantity;
      if (exact) report('cart', 'Your existing BIG W cart already matches this item.');
      else cart = await this.fillExistingCart(handle, cart, input, product, location, address, report, signal);
    } else {
      report('cart', 'Preparing a cart containing only the requested item.');
      cart = parseCartState(await this.req(handle, '/storefront/v1/cart/create', 'POST', {
        storeId: location.storeId, postcode: address.postcode, suburb: address.suburb.toUpperCase(), state: address.state,
        productCode: product.code, quantity: input.quantity, salesChannel: 'website',
      }));
    }
    if (!cart.id.startsWith('CT_')) throw new AppError('CHECKOUT_VERSION', 'This session returned a different BIG W checkout implementation. Preparation stopped before payment.');
    if (!reused) {
      // A brand-new cart has no contact/delivery details yet.
      report('contact', 'Applying validated delivery and billing details.');
      await this.applyCartDetails(handle, cart, input, location, address, signal);
    } else {
      // The account cart usually already holds the signed-in address/contact.
      // Only touch it when the authoritative guard says something differs;
      // this removes 3-4 calls from the common one-click path.
      try {
        guardCart(cart, input);
        report('contact', 'Saved delivery and contact details already match.');
      } catch (error) {
        const code = error instanceof AppError ? error.code : '';
        if (!['ADDRESS_REQUIRED', 'ADDRESS_CHANGED', 'CONTACT_CHANGED', 'CART_INVALID'].includes(code)) throw error;
        report('contact', 'Applying validated delivery and billing details.');
        await this.applyCartDetails(handle, cart, input, location, address, signal);
      }
    }
    return { cartId: cart.id, cart, product };
  }

  private async readCart(handle: BridgeHandle, cartId: string, state: string): Promise<CartState> {
    return parseCartState(await this.req(handle, `/storefront/v1/cart/${encodeURIComponent(cartId)}?state=${state}&channel=web`));
  }

  // Make the account cart contain exactly this product and quantity. BIG W
  // removes an item by updating it to quantity 0; /add adds it. The user can
  // opt out of replacement (then a non-empty cart fails with a clear message
  // instead of silently discarding their other items).
  private async fillExistingCart(
    handle: BridgeHandle, cart: CartState, input: RunRequest, product: ProductInfo,
    location: Location, address: RunRequest['profile']['deliveryAddress'], report: StageReporter, signal: AbortSignal,
  ): Promise<CartState> {
    const id = encodeURIComponent(cart.id);
    const body = (productCode: string, quantity: number) => ({
      storeId: location.storeId, postcode: address.postcode, suburb: address.suburb.toUpperCase(), state: address.state, productCode, quantity,
    });
    const others = cart.entries.filter(entry => entry.productCode !== product.code);
    const current = cart.entries.find(entry => entry.productCode === product.code);
    const replace = input.replaceCart !== false;
    if (!replace && others.length) {
      throw new AppError('CART_NOT_EMPTY', 'Your BIG W cart already has other items. Turn on “Replace my BIG W cart” in Duke, or empty the cart on BIG W, then try again.');
    }
    if (!replace && current && current.quantity !== input.quantity) {
      throw new AppError('CART_CHANGED', 'The BIG W cart already contains this product at a different quantity. Empty it or turn on cart replacement in Duke.');
    }
    if (others.length) {
      report('cart', `Replacing ${others.length} other cart item${others.length === 1 ? '' : 's'} with this product.`);
      // Independent removals run together; no artificial stagger.
      await Promise.all(others.map(entry => this.req(handle, `/storefront/v1/cart/${id}/update?channel=web`, 'POST', body(entry.productCode, 0))));
    }
    checkAbort(signal);
    if (current) {
      if (current.quantity !== input.quantity) {
        await this.req(handle, `/storefront/v1/cart/${id}/update?channel=web`, 'POST', body(product.code, input.quantity));
      }
    } else {
      report('cart', 'Adding the product to your BIG W cart.');
      await this.req(handle, `/storefront/v1/cart/${id}/add?channel=web`, 'POST', body(product.code, 1));
      if (input.quantity > 1) await this.req(handle, `/storefront/v1/cart/${id}/update?channel=web`, 'POST', body(product.code, input.quantity));
    }
    checkAbort(signal);
    return this.readCart(handle, cart.id, address.state);
  }

  private async applyCartDetails(
    handle: BridgeHandle, cart: CartState, input: RunRequest, location: Location,
    address: RunRequest['profile']['deliveryAddress'], signal: AbortSignal,
  ): Promise<void> {
    const id = encodeURIComponent(cart.id);
    // The three detail mutations are independent; run them together. The old
    // 120/240 ms stagger was politeness, not a correctness requirement, and it
    // delayed every one-click checkout.
    await Promise.all([
      this.req(handle, `/storefront/v1/cart/${id}/update-details?channel=web`, 'POST', {
        firstName: input.profile.firstName, lastName: input.profile.lastName, phone: input.profile.phone,
        authorityToLeave: false, deliveryAddress: this.apiAddress(address, input.profile), orderType: 'DELIVERY', fulfilmentType: 'DELIVERY',
      }),
      this.req(handle, `/storefront/v1/cart/${id}/fulfilment-preference?channel=web`, 'POST', {
        postcode: address.postcode, suburb: address.suburb.toUpperCase(), state: address.state,
        pickupStore: location.storeId, pickupStoresNearby: [location.storeId],
      }),
      this.req(handle, `/storefront/v1/cart/${id}/billing-address?channel=web`, 'POST', this.apiAddress(input.profile.billingSame ? address : input.profile.billingAddress!, input.profile)),
    ]);
    checkAbort(signal);
    await this.req(handle, `/storefront/v1/cart/${id}/recalculate?channel=web`, 'POST', {
      salesChannel: 'website', suburb: address.suburb.toUpperCase(), state: address.state,
      postcode: address.postcode, storeId: location.storeId, pickupStoresNearby: [location.storeId],
    });
  }

  // Server parity for the RunManager port: a full preparation is the cart work
  // followed by bringing the checkout on screen (src/server/browser/bigw.ts
  // prepare()). Kept as a thin composite so the ported RunManager stays verbatim.
  async prepare(input: RunRequest, product: ProductInfo, report: StageReporter, signal: AbortSignal): Promise<PreparedCheckout> {
    const prepared = await this.prepareCart(input, product, report, signal);
    await this.revealPrepared(prepared, report, signal);
    return prepared;
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
    const armed: ArmedCheckout = {
      productUrl: input.productUrl, productCode: product.code, quantity: input.quantity,
      maxTotalCents: input.maxTotalCents, profile: input.profile, product,
      cartId: prepared.cartId, cart: prepared.cart, armedAt: new Date().toISOString(),
      level: 'cart-ready',
    };
    // Publish as well as return: the RunManager reads armedState() synchronously
    // at the start of a matching run.
    this.armedStore?.set(armed);
    return armed;
  }

  // A standby arm for pre-release products: nothing cart-related is possible
  // yet, but the resolved product details (and, by the time a run fires, a warm
  // work tab via the same acquire seam) keep the release-moment run fast.
  private standbyArm(input: RunRequest, product: ProductInfo, note: string): ArmedCheckout {
    const armed: ArmedCheckout = {
      productUrl: input.productUrl, productCode: product.code, quantity: input.quantity,
      maxTotalCents: input.maxTotalCents, profile: input.profile, product,
      cartId: '', cart: { id: '', version: 0, total: 0, deliveryCost: 0, entries: [] },
      armedAt: new Date().toISOString(), level: 'standby', note,
    };
    this.armedStore?.set(armed);
    return armed;
  }

  async verify(prepared: PreparedCheckout, input: RunRequest): Promise<CartState> {
    const handle = await this.acquire();
    return parseCartState(await this.req(handle, `/storefront/v1/cart/${encodeURIComponent(prepared.cartId)}?state=${input.profile.deliveryAddress.state}&channel=web`));
  }

  // Verbatim port of the server BigWAdapter.savedCards() (src/server/browser/
  // bigw.ts): the bridge maps /storefront/v1/cart/saved-cards, and the same
  // id + 4-digit last4 filter drops malformed entries. The server's
  // listCards() first renews the session; the bridge reads the live token per
  // request, so that step has no extension equivalent.
  async savedCards(): Promise<SavedCard[]> {
    const handle = await this.acquire();
    const data = await this.req(handle, '/storefront/v1/cart/saved-cards');
    if (!Array.isArray(data)) return [];
    return data.map(value => { const card = record(value); return {
      id: string(card.id), brand: string(card.brand, 'Card'), last4: string(card.last4),
      expiryMonth: typeof card.expiryMonth === 'number' ? card.expiryMonth : undefined,
      expiryYear: typeof card.expiryYear === 'number' ? card.expiryYear : undefined,
    }; }).filter(card => card.id && /^\d{4}$/.test(card.last4));
  }
  async listCards(): Promise<SavedCard[]> { return this.savedCards(); }

  // Port of the server BigWAdapter.importProfile() (src/server/browser/bigw.ts).
  // The name/phone fallbacks, the `AU-` state strip, the forced country 'AU',
  // the primary-address preference, and the saved-card normalisation are
  // verbatim. Deliberate deviation: the server reads the live cart to prefer its
  // delivery address (and cart.customer for the recipient); the extension has no
  // page context for a cart, so the cart read is skipped and the primary address
  // (or the first) is used. With no cart payload `cart.customer` is empty on the
  // server too, so the remaining fallbacks are unchanged. The server's
  // `|| context.delivery?.state` fallback also needs page context, which the
  // extension lacks; the service worker therefore passes the stored profile's
  // delivery state as `fallbackState`, keeping an empty address state from
  // silently poisoning a later run.
  async importProfile(fallbackState?: string): Promise<{ profile: Profile; savedCards: SavedCard[] }> {
    const handle = await this.acquire();
    const [addressesData, accountData, cards] = await Promise.all([
      this.req(handle, '/profile/v1/addresses'),
      this.req(handle, '/profile/v1/profile'),
      this.savedCards(),
    ]);
    const account = record(accountData);
    const addresses = (Array.isArray(addressesData) ? addressesData : []).map(record);
    // The account address book uses `defaultAddress` / `postCode` / `regionCode`
    // (BIG W's cart payload uses `postcode` / `state`), so prefer a complete
    // address and read both shapes.
    const hasPostcode = (value: Record<string, unknown>) => string(value.postcode, string(value.postCode)).length > 0;
    const address = addresses.find(item => item.defaultAddress === true && hasPostcode(item))
      ?? addresses.find(item => item.defaultAddress === true)
      ?? addresses.find(item => item.primary === true)
      ?? addresses.find(hasPostcode)
      ?? addresses[0]
      ?? {};
    const name = record(account.name), phone = record(account.phone);
    const normalize = (value: Record<string, unknown>): Address => ({
      line1: string(value.line1), line2: string(value.line2), suburb: string(value.suburb, string(value.town)),
      postcode: string(value.postcode, string(value.postCode)),
      state: string(value.state).replace('AU-', '') || string(value.regionCode) || fallbackState || '',
      country: 'AU',
    });
    return { profile: {
      name: 'BIG W delivery', firstName: string(address.firstName, string(name.given)),
      lastName: string(address.lastName, string(name.family)),
      phone: string(address.phonenumber, string(phone.mobile)),
      deliveryAddress: normalize(address), billingSame: true,
    }, savedCards: cards };
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
    // Consume the trigger's presentation tab once: the tab the user is already
    // watching becomes the checkout. A mismatched requestId (stale tab from a
    // failed run) is ignored.
    const presentation = this.presentation;
    const presentationTabId = presentation && presentation.requestId === this.runRequestId ? presentation.tabId : undefined;
    if (presentationTabId !== undefined) this.presentation = undefined;
    if (opts?.reuseMountedPage && presentationTabId === undefined && /\/checkout\//.test(url)) {
      report('payment', 'The armed checkout is already open — confirming its secure fields.');
      await driver.activate();
      this.checkoutTabId = handle.tabId;
      await this.ready(handle, signal);
      return;
    }
    // The run prepared everything in the background work tab; the only visible
    // step is turning the presentation tab into the checkout (never the app
    // page, never a second blank tab).
    report('payment', 'Opening the prepared checkout.');
    this.checkoutTabId = await driver.openCheckoutTab(CHECKOUT_URL, { tabId: presentationTabId });
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
    const handle = await this.acquire(this.checkoutTabId);
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
    const handle = await this.acquire(this.checkoutTabId);
    const driver = this.driverOf(handle);
    if (signal) checkAbort(signal);
    // The MAIN-world observer's ring buffer outlives a run; drop it so a stale
    // entry from a previous attempt cannot settle this submission.
    await driver.observeClear?.().catch(() => undefined);
    return new Promise<PaymentOutcome>(resolve => {
      // `observed` is the sent signal, mirroring the server's PaymentGuard.onSent:
      // it becomes true once a payment request (`/pay` or `/pay/finalize`) has
      // actually been sent. The MAIN-world observer records a sent request as an
      // entry with status -1 (in flight) that it later updates in place with the
      // real status (0 = network failure). A Pay click that does nothing — the
      // secure fields were rebuilt — produces no entry and must keep retrying.
      let settled = false, observed = false, guardEnabled = false, guardEnabledAt = 0, requestedAction = false, checkingObserve = false, checkingState = false;
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
              // status -1 = the request was sent and its response is still in
              // flight; status >= 0 = a settled response (0 = network failure).
              // Either way the request was actually sent (PaymentGuard.onSent).
              observed = true;
              if (entry.status === -1) continue;
              if (entry.status === 0) { finish(unknown); return; }
              if (entry.status >= 200) {
                let value: unknown;
                try { value = JSON.parse(entry.bodyText); } catch { value = undefined; }
                const body = record(record(value).data ?? value);
                pendingReference = orderReference(body) ?? pendingReference;
                const outcome = interpretPaymentResult(value, entry.status);
                if (outcome) { finish(outcome); return; }
              }
            }
            // Guard-event bridge: the MAIN-world guard can block a submission
            // before it reaches the network (a changed cart/version/amount/
            // session or a duplicate), so no observer entry and no `sent` event
            // appear. The server finishes these as `blocked` via
            // PaymentGuard.onPrevented; mirror that instead of waiting out the
            // deadline as `unknown`. A `sent` event means the payment went out,
            // so a later prevented event (a duplicate) must not override it.
            if (settled) return;
            if (!observed && guardEnabled) {
              const events = await driver.guardEvents().catch(() => []);
              const relevant = events.filter(event => event.at >= guardEnabledAt);
              if (!relevant.some(event => event.type === 'sent')) {
                const prevented = relevant.find(event => event.type === 'prevented');
                if (prevented) {
                  finish({ status: 'blocked', code: prevented.code ?? 'PAYMENT_CHANGED', message: BLOCKED_MESSAGE });
                  return;
                }
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
      // Server equivalent: PaymentGuard.onSent. Only fail after 20 s if no
      // payment request was ever sent (observed is false); once one has been
      // sent, a slow response must not settle as unknown.
      const vaultDeadline = setTimeout(() => { if (!observed) finish(unknown); }, 20_000);

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
          guardEnabledAt = Date.now();
          if (card.kind === 'new') {
            const fields: [string, string][] = [['number', card.number], ['expiryDate', card.expiry], ['securityCode', card.cvv]];
            const normalize = (value?: string) => (value ?? '').replace(/\D/g, '');
            // The checkout rebuilds the secure fields shortly after fill, which
            // clears the card and turns a Pay click into a silent no-op. Keep
            // re-filling and clicking until a payment request is actually sent
            // (observed), exactly like the server: a silent no-op click reports
            // clicked:true but sends nothing, so it must not stop the loop. The
            // guard allows only the first submission, so re-clicking is safe.
            for (let attempt = 0; attempt < 6 && !settled && !observed; attempt++) {
              if (!(await this.valuesPersisted(driver, fields, normalize))) {
                try { await this.fillCard(card); } catch { /* fill logs its own reason */ }
              }
              if (settled || observed) break;
              await driver.sendTop({ type: 'driver.clickPay' }).catch(() => undefined);
              const until = Date.now() + 4000;
              while (Date.now() < until && !settled && !observed) await sleep(200);
              if (!settled && !observed) console.log(`[duke] card submit: no payment seen after click ${attempt + 1}; retrying`);
            }
            if (!observed && !settled) finish(unknown);
          } else {
            const fingerprint = (await driver.antiFraud()).fingerprint;
            // The stored-card /pay request is recorded by the MAIN world as a
            // pending entry the moment it is forwarded, so `observed` (onSent)
            // is set without a click; its response is interpreted directly below.
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
    const handle = await this.acquire(this.checkoutTabId);
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
    const handle = await this.acquire(this.checkoutTabId).catch(() => undefined);
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
