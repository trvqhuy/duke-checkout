// Stage-1 end-to-end smoke: the built unpacked extension (dist-extension/) is
// loaded into a fixture Chrome, the app page is opened, and the full
// UI → service worker → adapter → bridge → content-script loop is exercised
// against an intercepted retailer. The arm is validated at the CART-READY
// level: the work tab is created by the test itself with interception attached
// before the service worker ever queries tabs, so there is no interception
// race and the whole create → update-details → fulfilment-preference →
// billing-address → recalculate chain can be served.
// Prerequisite: `npm run build:ext` (asserted below with a clear message).
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser, type HTTPRequest, type Page, type Target } from 'puppeteer-core';
import { profile, productUrl } from '../fixtures.ts';

const extensionDir = resolve('dist-extension');

let temporary: string;
let browser: Browser;
let extensionId: string;
let appPage: Page;
let workPage: Page;

const fixtureProduct = [{ code: '6071620', name: 'A controlled extension smoke fixture', soldByItself: false, variants: [{ code: '6071620', assets: [{ images: [{ uri: '/medias/fixture.svg' }] }] }], vendorInformation: { vendorType: 'BIGW' } }];
const availability = { products: { '6071620': { minDeliveryFee: 400, delivery: { 'Standard Delivery': { available: true, quantity: 5, estimatedDelivery: '27–30 October' } } } } };
const address = { ...profile.deliveryAddress, firstName: profile.firstName, lastName: profile.lastName, phonenumber: '+61412345678' };
let cart = { id: 'CT_ext_fixture', version: 1, entries: [{ productCode: '6071620', quantity: 1 }], total: 2200, deliveryCost: 400, deliveryAddress: { ...address }, billingAddress: { ...address }, customer: { firstName: profile.firstName, lastName: profile.lastName, phone: '+61412345678' }, validation: { isValid: true } };
const cors = { 'access-control-allow-origin': 'https://www.bigw.com.au', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'authorization3,authorization,content-type,optly-user', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const requestedPaths: string[] = [];
const runtimeErrors: string[] = [];

// The MAIN-world bridge resolves the cart token from the page's Auth0 SPA
// cache (resolveToken in api-bridge-main.ts); cart mutations need
// cart:manage. Seeded by the intercepted page itself at document load, before
// the bridge can serve any request.
function bigwHtml() {
  const cacheKey = '@@auth0spajs@@::client1::https://api.bigw.com.au/api::openid profile cart:manage';
  return `<!doctype html><html><body><h1>Extension fixture</h1><script>
    localStorage.setItem(${JSON.stringify(cacheKey)}, JSON.stringify({
      body: { access_token: 'ext-fixture-token', client_id: 'client1', scope: 'openid profile cart:manage' },
      expiresAt: Date.now() / 1000 + 600 }));
  </script></body></html>`;
}

async function intercept(request: HTTPRequest) {
  const url = new URL(request.url());
  if (url.origin === 'https://www.bigw.com.au') {
    await request.respond({ status: 200, contentType: 'text/html', body: bigwHtml() }, 0); return;
  }
  if (!['https://api.bigw.com.au', 'https://apix.bigw.com.au'].includes(url.origin)) {
    await request.abort('blockedbyclient', 0); return;
  }
  if (request.method() === 'OPTIONS') { await request.respond({ status: 204, headers: cors }, 0); return; }
  const path = url.pathname;
  requestedPaths.push(path);
  let body: unknown;
  if (path.includes('/product-price-api/v1/products')) body = fixtureProduct;
  else if (path.includes('/product-price-api/v1/prices/')) body = [{ price: { centAmount: 1800 }, label: 'PRE-ORDER' }];
  else if (path.startsWith('/warehouse-customer/')) body = [{ state: 'NSW', miraklZone: 'ZONE_1', zoneClassification: 'METRO' }];
  else if (path.startsWith('/api/availability/')) body = availability;
  else if (path === '/api/stores/v0/list') body = [{ id: 'S1', name: 'Sydney Store', address: { state: 'NSW' } }];
  else if (path.includes('/storefront/v1/cart/')) {
    if (path.endsWith('/create')) {
      const data = request.postData() ? JSON.parse(request.postData()!) : {};
      cart = { ...cart, entries: [{ productCode: data.productCode, quantity: data.quantity }] };
      body = cart;
    } else {
      body = cart;
    }
    if (request.method() === 'POST' && !path.endsWith('/create')) cart.version++;
  } else { await request.abort('blockedbyclient', 0); throw new Error(`Unmapped extension-fixture endpoint: ${path}`); }
  await request.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) }, 0);
}

const isServiceWorker = (target: Target) => target.type() === 'service_worker';

async function launchExtensionBrowser(): Promise<{ browser: Browser; extensionId: string }> {
  const browser = await puppeteer.launch({
    channel: 'chrome',
    headless: true, // new headless: old headless does not load extensions
    userDataDir: join(temporary, 'chrome'),
    enableExtensions: true, // CDP Extensions.loadUnpacked needs this flag
    args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage'],
  });
  // Branded Chrome ≥137 ignores --load-extension, so the unpacked extension
  // is installed through the CDP Extensions domain instead.
  const extensionId = await browser.installExtension(extensionDir);
  // MV3 service worker target confirms the background is alive.
  await browser.waitForTarget(
    target => isServiceWorker(target) && target.url().includes(extensionId),
    { timeout: 20_000 },
  );
  return { browser, extensionId };
}

beforeAll(async () => {
  if (!existsSync(join(extensionDir, 'manifest.json')) || !existsSync(join(extensionDir, 'background.js'))) {
    throw new Error('dist-extension/ is missing. Run `npm run build:ext` before this suite.');
  }
  temporary = await mkdtemp('/tmp/opencode/duke-extension-smoke-');
  ({ browser, extensionId } = await launchExtensionBrowser());
  // The work tab exists before any SW acquire: acquireWorkTab() reuses it, and
  // interception is already attached, so every retailer request is served.
  workPage = await browser.newPage();
  await workPage.setRequestInterception(true);
  workPage.on('request', request => intercept(request).catch(async () => { if (!request.isInterceptResolutionHandled()) return request.abort('failed', 100); }));
  workPage.on('pageerror', error => runtimeErrors.push(`work pageerror: ${String(error)}`));
  await workPage.goto('https://www.bigw.com.au/', { waitUntil: 'load' });
  appPage = await browser.newPage();
  appPage.on('pageerror', error => runtimeErrors.push(`app pageerror: ${String(error)}`));
  await appPage.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: 'domcontentloaded' });
  // The extension must be able to see the work tab AND its isolated bridge
  // must answer a ping before the flow can run (the unpacked extension can be
  // caught reloading itself shortly after install).
  for (let attempts = 0; attempts < 40; attempts++) {
    const probe: { bigwUrl: string | null; reply: unknown } = await appPage.evaluate(async () => {
      const bigw = (await chrome.tabs.query({})).find(tab => tab.url?.includes('bigw.com.au'));
      return {
        bigwUrl: bigw?.url ?? null,
        reply: bigw?.id ? await chrome.tabs.sendMessage(bigw.id, { type: 'bridge.ping' }).catch(error => `ERR ${String(error)}`) : 'no bigw tab',
      };
    });
    if ((probe.reply as { pong?: boolean } | undefined)?.pong) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}, 90_000);

afterAll(async () => {
  await browser?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe('extension stage-1 integration', () => {
  it('loads, opens the app page, inspects, and arms cart-ready through the work tab', async () => {
    // 1. Bootstrap renders the settings card with defaults.
    await appPage.waitForSelector('#field-quantity', { timeout: 20_000 });
    expect(await appPage.$eval('#field-quantity', element => (element as HTMLInputElement).value)).toBe('1');
    expect(await appPage.$eval('#field-maxTotalAUD', element => (element as HTMLInputElement).value)).toBe('1000.00');

    // 2. Profile: fill and persist through profile.put.
    await appPage.locator('#field-firstName').fill(profile.firstName);
    await appPage.locator('#field-lastName').fill(profile.lastName);
    await appPage.locator('#field-phone').fill(profile.phone);
    await appPage.locator('#field-deliveryAddress-line1').fill(profile.deliveryAddress.line1);
    await appPage.locator('#field-deliveryAddress-suburb').fill(profile.deliveryAddress.suburb);
    await appPage.select('#deliveryAddress-state', 'NSW');
    await appPage.locator('#field-deliveryAddress-postcode').fill(profile.deliveryAddress.postcode);
    await appPage.locator('.profile-save-row .secondary-button').click();
    const storedProfile = await appPage.evaluate(async () => (await chrome.storage.local.get(['dukeProfile'])).dukeProfile);
    expect(storedProfile).toMatchObject({ firstName: profile.firstName, phone: profile.phone, deliveryAddress: { suburb: profile.deliveryAddress.suburb, state: 'NSW' } });

    // 3. Inspect through the service worker → adapter → bridge → MAIN world.
    await appPage.locator('#field-productUrl').fill(productUrl);
    await appPage.locator('.inspect-button').click();
    await appPage.waitForSelector('.inspection-result', { timeout: 30_000 });
    const inspection = await appPage.$eval('.inspection-result', element => element.textContent ?? '');
    expect(inspection).toContain('$18.00');
    expect(inspection).toContain('Pre-order');

    // 4. Arm through the full chain; cart endpoints are served, so the arm
    //    lands at cart-ready.
    await appPage.locator('.armed-strip .secondary-button.compact').click();
    await appPage.waitForSelector('.armed-strip.armed', { timeout: 45_000 });
    const armedText = await appPage.$eval('.armed-strip', element => element.textContent ?? '');
    expect(armedText).toContain('cart ready');
    expect(armedText).toContain('$22.00');

    // 5. The armed state is authoritative in chrome.storage.session.
    const armed = await appPage.evaluate(async () => (await chrome.storage.session.get(['dukeArmed'])).dukeArmed);
    expect(armed).toMatchObject({ productCode: '6071620', quantity: 1, cartId: 'CT_ext_fixture', level: 'cart-ready' });

    // 6. The work tab served the whole chain in order.
    expect(requestedPaths).toEqual(expect.arrayContaining([
      '/apim/product-price-api/v1/products',
      '/apim/product-price-api/v1/prices/6071620',
      '/storefront/v1/cart/create',
      '/storefront/v1/cart/CT_ext_fixture/update-details',
      '/storefront/v1/cart/CT_ext_fixture/fulfilment-preference',
      '/storefront/v1/cart/CT_ext_fixture/billing-address',
      '/storefront/v1/cart/CT_ext_fixture/recalculate',
    ]));

    // 7. No runtime errors on either side of the bridge.
    expect(runtimeErrors, runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);
});
