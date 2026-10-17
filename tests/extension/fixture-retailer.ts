// Shared retailer fixture for the extension integration suites. Extracted from
// the Stage-1 smoke harness (tests/extension/integration.test.ts) and extended
// with the Stage-2 checkout page, the Gr4vy secure-field frames, and a
// configurable `/pay` endpoint. The Stage-1 suite keeps its own inline
// interceptor so its assertions and flow stay untouched; the Stage-2 suite
// builds the full purchase/decline/assist/cancel scenarios on this module.
//
// The fixture is a real Puppeteer request interceptor: it answers the BIG W
// document and API origins, the Gr4vy secure-field documents, and the cart/pay
// endpoints. Everything is served from memory — no network is used for the
// retailer.
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser, type HTTPRequest, type Page, type Target } from 'puppeteer-core';
import { profile, productUrl, testCard } from '../fixtures.ts';

export { profile, productUrl, testCard };

export const extensionDir = resolve('dist-extension');
export const CART_ID = 'CT_ext_fixture';
export const CART_TOTAL = 2200;
export const CART_DELIVERY = 400;
export const PRODUCT_CODE = '6071620';
export const SESSION_FIXTURE = 'SESSION_FIXTURE';

// The MAIN-world bridge resolves the cart token from the page's Auth0 SPA
// cache (resolveToken in api-bridge-main.ts). The Stage-2 run reads the cart
// (cart:view) and mutates it (cart:manage), so the seeded scope must satisfy
// both. Seeded by each served document at load, before the bridge serves any
// request.
export const AUTH_SCOPE = 'openid profile cart:manage cart:view payment:manage payment:authorise account:view account:pii:view payment:view';

export function authCacheScript(): string {
  const cacheKey = `@@auth0spajs@@::client1::https://api.bigw.com.au/api::${AUTH_SCOPE}`;
  return `localStorage.setItem(${JSON.stringify(cacheKey)}, JSON.stringify({ body: { access_token: 'ext-fixture-token', client_id: 'client1', scope: ${JSON.stringify(AUTH_SCOPE)} }, expiresAt: Date.now() / 1000 + 600 }));`;
}

export const fixtureProduct = [{
  code: PRODUCT_CODE, name: 'A controlled extension smoke fixture', soldByItself: false,
  variants: [{ code: PRODUCT_CODE, assets: [{ images: [{ uri: '/medias/fixture.svg' }] }] }],
  vendorInformation: { vendorType: 'BIGW' },
}];
export const availability = { products: { [PRODUCT_CODE]: { minDeliveryFee: CART_DELIVERY, delivery: { 'Standard Delivery': { available: true, quantity: 5, estimatedDelivery: '27–30 October' } } } } };
export const address = { ...profile.deliveryAddress, firstName: profile.firstName, lastName: profile.lastName, phonenumber: '+61412345678' };
export const cors = {
  'access-control-allow-origin': 'https://www.bigw.com.au',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'authorization3,authorization,content-type,optly-user',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

export function baseCart(version = 1) {
  return {
    id: CART_ID,
    version,
    entries: [] as { productCode: string; quantity: number }[],
    total: CART_TOTAL,
    deliveryCost: CART_DELIVERY,
    deliveryAddress: { ...address },
    billingAddress: { ...address },
    customer: { firstName: profile.firstName, lastName: profile.lastName, phone: '+61412345678' },
    validation: { isValid: true },
  };
}
export type FixtureCart = ReturnType<typeof baseCart>;

export interface FixtureOptions {
  payResponse?: 'confirmed' | 'declined';
  duplicatePay?: boolean;
  delayCreateMs?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class RetailerFixture {
  cart: FixtureCart = baseCart();
  payResponse: 'confirmed' | 'declined' = 'confirmed';
  duplicatePay = false;
  delayCreateMs = 0;
  requestedPaths: string[] = [];
  payPosts = 0;
  payBodies: Array<Record<string, unknown>> = [];
  runtimeErrors: string[] = [];

  reset(options: FixtureOptions = {}): void {
    this.cart = baseCart();
    this.payResponse = options.payResponse ?? 'confirmed';
    this.duplicatePay = options.duplicatePay ?? false;
    this.delayCreateMs = options.delayCreateMs ?? 0;
    this.requestedPaths = [];
    this.payPosts = 0;
    this.payBodies = [];
    this.runtimeErrors = [];
  }

  // The plain BIG W document the work tab starts on: it only seeds the Auth0
  // cache so the bridge can serve the pre-navigation cart mutations.
  authHtml(): string {
    return `<!doctype html><html><body><h1>Extension fixture</h1><script>${authCacheScript()}</script></body></html>`;
  }

  // The checkout page the driver navigates to. It mounts the three Gr4vy
  // secure-field iframes the driver fills, exposes the new-card control and the
  // exact Pay form the driver clicks, and on submit issues the guarded
  // `/pay` request with the shape checkPaymentRequest accepts for a `new`
  // binding. The cart version is embedded at serve time from the live cart.
  checkoutHtml(): string {
    const payload = {
      cartId: CART_ID,
      cartVersion: this.cart.version,
      deviceFingerprint: 'fp',
      transactions: { creditCardPaymentInfo: { amountInCents: CART_TOTAL, sessionId: SESSION_FIXTURE, storePaymentMethod: false } },
    };
    const second = this.duplicatePay ? 'payRequest();' : '';
    return `<!doctype html><html><body>
<script>${authCacheScript()}</script>
<h1>BIG W checkout fixture</h1>
<iframe src="https://secure-fields.wpay2.gr4vy.app/input.html?type=number&sessionId=${SESSION_FIXTURE}"></iframe>
<iframe src="https://secure-fields.wpay2.gr4vy.app/input.html?type=expiryDate&sessionId=${SESSION_FIXTURE}"></iframe>
<iframe src="https://secure-fields.wpay2.gr4vy.app/input.html?type=securityCode&sessionId=${SESSION_FIXTURE}"></iframe>
<label><input type="radio" name="savedOrNewCards" value="false" checked />New card</label>
<div data-testid="pay-with-new-card"><form><button type="submit">Pay $22.00 with credit card</button></form></div>
<script>
  var payload = ${JSON.stringify(payload)};
  function payRequest() {
    return fetch('https://api.bigw.com.au/storefront/v1/cart/${CART_ID}/pay', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }).catch(function () {});
  }
  document.querySelector('[data-testid="pay-with-new-card"] form').addEventListener('submit', function (event) {
    event.preventDefault();
    payRequest();
    ${second}
  });
</script>
</body></html>`;
  }

  // Minimal Gr4vy secure-field document: a single visible input the driver
  // writes through the native prototype setter.
  fieldHtml(): string {
    return '<!doctype html><html><body><input aria-label="secure field" autocomplete="off" /></body></html>';
  }

  async intercept(request: HTTPRequest): Promise<void> {
    const url = new URL(request.url());
    if (url.origin === 'https://www.bigw.com.au') {
      const body = url.pathname.startsWith('/checkout/') ? this.checkoutHtml() : this.authHtml();
      await request.respond({ status: 200, contentType: 'text/html', body }, 0);
      return;
    }
    if (url.origin === 'https://secure-fields.wpay2.gr4vy.app') {
      await request.respond({ status: 200, contentType: 'text/html', body: this.fieldHtml() }, 0);
      return;
    }
    if (!['https://api.bigw.com.au', 'https://apix.bigw.com.au'].includes(url.origin)) {
      await request.abort('blockedbyclient', 0);
      return;
    }
    if (request.method() === 'OPTIONS') { await request.respond({ status: 204, headers: cors }, 0); return; }
    const path = url.pathname;
    this.requestedPaths.push(path);

    // The guarded payment endpoint. Configurable so the run's outcome (and the
    // guard's decision) can be driven from the fixture: 200 confirmed vs 409
    // INVALID_PAYMENT declined.
    if (request.method() === 'POST' && path === `/storefront/v1/cart/${CART_ID}/pay`) {
      this.payPosts++;
      const raw = request.postData();
      this.payBodies.push(raw ? JSON.parse(raw) : {});
      if (this.payResponse === 'declined') {
        await request.respond({ status: 409, contentType: 'application/json', headers: cors, body: JSON.stringify({ errorCode: 'INVALID_PAYMENT' }) }, 0);
      } else {
        await request.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ orderNumber: 'ORD-1' }) }, 0);
      }
      return;
    }

    let body: unknown;
    if (path.includes('/product-price-api/v1/products')) body = fixtureProduct;
    else if (path.includes('/product-price-api/v1/prices/')) body = [{ price: { centAmount: 1800 }, label: 'PRE-ORDER' }];
    else if (path.startsWith('/warehouse-customer/')) body = [{ state: 'NSW', miraklZone: 'ZONE_1', zoneClassification: 'METRO' }];
    else if (path.startsWith('/api/availability/')) body = availability;
    else if (path === '/api/stores/v0/list') body = [{ id: 'S1', name: 'Sydney Store', address: { state: 'NSW' } }];
    // Profile import (Stage-3 onboarding): the account name/phone and the
    // primary delivery address the adapter normalises into a stored profile.
    else if (path === '/profile/v1/addresses') body = [{ primary: true, ...address }];
    else if (path === '/profile/v1/profile') body = { name: { given: profile.firstName, family: profile.lastName }, phone: { mobile: address.phonenumber } };
    else if (path.includes('/storefront/v1/cart/')) {
      if (path.endsWith('/create')) {
        const data = request.postData() ? JSON.parse(request.postData()!) : {};
        this.cart = { ...this.cart, version: 1, entries: [{ productCode: data.productCode, quantity: data.quantity }] };
        if (this.delayCreateMs) await sleep(this.delayCreateMs);
        body = { ...this.cart };
      } else if (request.method() === 'POST') {
        // A cart-detail mutation advances the version; the run's later verify
        // reads this same version and binds it into the guard.
        this.cart = { ...this.cart, version: this.cart.version + 1 };
        body = { ...this.cart };
      } else {
        body = { ...this.cart };
      }
    } else {
      this.runtimeErrors.push(`Unmapped extension-fixture endpoint: ${path}`);
      await request.abort('blockedbyclient', 0);
      throw new Error(`Unmapped extension-fixture endpoint: ${path}`);
    }
    await request.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) }, 0);
  }
}

export const isServiceWorker = (target: Target): boolean => target.type() === 'service_worker';

export async function launchExtensionBrowser(temporary: string, dir = extensionDir): Promise<{ browser: Browser; extensionId: string }> {
  const browser = await puppeteer.launch({
    channel: 'chrome',
    headless: true, // new headless: old headless does not load extensions
    userDataDir: join(temporary, 'chrome'),
    enableExtensions: true, // CDP Extensions.loadUnpacked needs this flag
    args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage'],
  });
  // Branded Chrome ≥137 ignores --load-extension, so the unpacked extension is
  // installed through the CDP Extensions domain instead.
  const extensionId = await browser.installExtension(dir);
  await browser.waitForTarget(target => isServiceWorker(target) && target.url().includes(extensionId), { timeout: 20_000 });
  return { browser, extensionId };
}

export async function makeTemporaryDir(prefix: string): Promise<string> {
  return mkdtemp(join('/tmp/opencode', prefix));
}

// The service worker addresses "the" app tab (install opens onboarding in one,
// later triggers focus/navigate the same tab), so tests must reuse an existing
// app tab rather than opening a second one the SW would ignore.
// Keep exactly one app tab: the service worker navigates "the" app tab, and a
// second one (for example the asynchronous first-install onboarding tab) would
// silently receive the navigation instead of the tab the test is driving.
export async function keepOnlyAppTab(browser: Browser, keep: Page, extensionId: string): Promise<void> {
  const base = `chrome-extension://${extensionId}/app.html`;
  for (const page of await browser.pages()) {
    if (page !== keep && page.url().startsWith(base)) await page.close().catch(() => undefined);
  }
}

export async function findOrOpenAppTab(browser: Browser, extensionId: string): Promise<Page> {
  const base = `chrome-extension://${extensionId}/app.html`;
  // The service worker addresses "the" app tab, so exactly one may exist. A
  // fresh install opens onboarding asynchronously, which can race the harness
  // into a second tab; keep one and close the rest so both sides agree.
  const matches = async () => (await browser.pages()).filter(page => page.url().startsWith(base));
  let pages = await matches();
  if (pages.length > 1) {
    for (const extra of pages.slice(1)) await extra.close().catch(() => undefined);
    pages = await matches();
  }
  const page = pages[0] ?? await browser.newPage();
  if (!page.url().startsWith(base)) await page.goto(base, { waitUntil: 'domcontentloaded' });
  return page;
}

export function assertExtensionBuilt(): void {
  if (!existsSync(join(extensionDir, 'manifest.json')) || !existsSync(join(extensionDir, 'background.js'))) {
    throw new Error('dist-extension/ is missing. Run `npm run build:ext` before this suite.');
  }
}

// Wait until the extension can see the work tab AND its isolated bridge answers
// a ping (the freshly-installed unpacked extension can reload itself briefly).
export async function waitForBridgePing(appPage: Page, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastProbe: unknown = null;
  while (Date.now() < deadline) {
    const probe: { bigwUrl: string | null; reply: unknown } = await appPage.evaluate(async () => {
      const bigw = (await chrome.tabs.query({})).find(tab => tab.url?.includes('bigw.com.au'));
      return {
        bigwUrl: bigw?.url ?? null,
        reply: bigw?.id ? await chrome.tabs.sendMessage(bigw.id, { type: 'bridge.ping' }).catch(error => `ERR ${String(error)}`) : 'no bigw tab',
      };
    });
    lastProbe = probe;
    if ((probe.reply as { pong?: boolean } | undefined)?.pong === true) return;
    await sleep(500);
  }
  throw new Error(`bridge.ping never answered: ${JSON.stringify(lastProbe)}`);
}

// Reads the values currently held by the three Gr4vy secure-field frames.
export async function readSecureFieldValues(page: Page): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!url.startsWith('https://secure-fields.wpay2.gr4vy.app/input.html')) continue;
    const type = new URL(url).searchParams.get('type');
    if (!type) continue;
    try { out[type] = await frame.$eval('input', (element: unknown) => (element as HTMLInputElement).value); }
    catch { out[type] = undefined; }
  }
  return out;
}
