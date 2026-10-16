// BIG W retailer adapter for the extension, adapted from the server original
// (src/server/browser/bigw.ts). Same endpoints, bodies, stagger, and product
// semantics; deliberate deviations forced by the bridge (no live Page):
// (a) steps are acquire-based — each public step starts a fresh bridge handle
//     via the acquire() seam instead of this.session()/livePage();
// (b) inspect() runs the same store/location resolution, but locationFor()
//     always resolves the storeId through the stores API (no page-context
//     storeId is available);
// (c) prepareCart() has no page context, so the existing-cart reuse branch and
//     the cart publish into the page's local state are skipped (Stage 2);
// (d) arm()/standbyArm() skip the checkout-page preload warm-up (Stage 2 adds
//     it via the checkout driver); the STANDBY downgrade notes are unchanged;
// (e) verify() skips the page-context cartId comparison and only re-invalidates
//     the cart through the bridge.
// The bridge reads the live token per request, so no session renewal step
// exists here.
import { parseProductLink } from '../../../../shared/validation.ts';
import { buildProductInfo, parseCartState, record, string } from '../../../../server/browser/bigw-model.ts';
import { AppError, checkAbort } from '../../../../server/errors.ts';
import { bridgeRequest } from '../../../background/bridge-client.ts';
import { scopesForPath } from '../../../content/api-bridge-main.ts';
import type { BridgeHandle, RetailerAdapter } from '../types.ts';
import type { ArmedCheckout, CartState, PreparedCheckout, ProductInfo, Profile, RunRequest, StageReporter } from '../../../../shared/types.ts';

// Failure codes that mean "the retailer is not accepting this product yet" —
// the pre-release case. Arming downgrades to a standby instead of failing.
const STANDBY_CODES = ['UNAVAILABLE', 'STORE_REQUEST', 'REQUEST_NETWORK', 'REQUEST_TIMEOUT', 'CART_INVALID'];

interface Location { storeId: string; zone?: string; zoneType?: string }

export class BigWExtensionAdapter implements RetailerAdapter {
  readonly urlPattern = /https:\/\/www\.bigw\.com\.au\/product\/[^/]+\/p\/(\d+)/;
  private location?: Location;
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
    try {
      availability = await Promise.race([
        this.req(handle, `/api/availability/v0/product/${code}?${query}`, 'GET', undefined, 'https://api.bigw.com.au', true),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2_000)),
      ]);
    } catch (error) {
      if (!(error instanceof AppError) || !['REQUEST_NETWORK', 'REQUEST_TIMEOUT'].includes(error.code)) throw error;
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
}
