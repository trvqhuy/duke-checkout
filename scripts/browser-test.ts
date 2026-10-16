import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';
import puppeteer, { type HTTPRequest } from 'puppeteer-core';
import { createApp } from '../src/server/app.ts';
import { BigWAdapter } from '../src/server/browser/bigw.ts';
import { BrowserConnection } from '../src/server/browser/connection.ts';
import { RunManager } from '../src/server/checkout.ts';
import { LocalStore } from '../src/server/storage.ts';
import { profile, productUrl, testCard } from '../tests/fixtures.ts';
import type { ConnectionState } from '../src/shared/types.ts';

// Every retailer/provider request is intercepted in a disposable test browser.
// This script cannot send a payment to BIG W or access the user's Chrome profile.
const temporary = await mkdtemp('/tmp/opencode/duke-browser-test-');
const browser = await puppeteer.launch({ channel: 'chrome', headless: true, userDataDir: join(temporary, 'chrome'), args: ['--disable-dev-shm-usage'] });
const probe = new BrowserConnection({ endpoint: browser.wsEndpoint() });
await probe.connect(); await probe.disconnect();
console.log('PASS: standalone browser transport attaches and disconnects without closing Chrome.');
const connection = Object.assign(new EventEmitter(), {
  state: { status: 'disconnected', message: 'Fixture browser ready.' } as ConnectionState,
  async connect(): Promise<ConnectionState> {
    if (this.state.status !== 'connected') {
      this.state = { status: 'connected', message: 'Fixture browser connected.', browser: await browser.version() };
      connection.emit('change', this.state);
    }
    return this.state;
  },
  async page() { await this.connect(); await retail.setRequestInterception(true); return retail; },
  async disconnect() {},
});
const store = new LocalStore(join(temporary, 'data'));
const adapter = new BigWAdapter(connection);
const manager = new RunManager(store, adapter);
await store.saveProfile(profile); await manager.init();
const app = createApp({ store, adapter, browser: connection, manager, token: await store.localToken() });
app.use(express.static(resolve('dist')));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let paymentCount = 0;
const paymentBodies: string[] = [];
const localActions: string[] = [];
let expensive = false;
let tamperPayment = false;
let holdAvailability = false;
let availabilityStarted = new EventEmitter();
let releaseAvailability: (() => void) | undefined;
const address = { ...profile.deliveryAddress, firstName: profile.firstName, lastName: profile.lastName, phonenumber: '+61412345678' };
let cart = { id: 'CT_browser_fixture', version: 1, entries: [{ productCode: '6071620', quantity: 1 }], total: 2200, deliveryCost: 400, deliveryAddress: { ...address }, billingAddress: { ...address }, customer: { firstName: profile.firstName, lastName: profile.lastName, phone: '+61412345678' }, validation: { isValid: true } };
const fixtureProduct = [{ code: '6071620', name: 'A preorder book — controlled browser fixture', soldByItself: false, variants: [{ code: '6071620', assets: [{ images: [{ uri: '/medias/fixture.svg' }] }] }], vendorInformation: { vendorType: 'BIGW' } }];
const availability = { products: { '6071620': { minDeliveryFee: 400, delivery: { 'Standard Delivery': { available: true, quantity: 0, estimatedDelivery: '27–30 October' } } } } };
const fieldsOrigin = 'https://secure-fields.wpay2.gr4vy.app';
const cors = { 'access-control-allow-origin': 'https://www.bigw.com.au', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'authorization3,authorization,content-type,optly-user', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

function checkoutHtml() {
  const cacheKey = '@@auth0spajs@@::fixture::https://api.bigw.com.au/api::cart:view cart:manage account:view account:pii:view payment:view payment:manage payment:authorise';
  return `<!doctype html><html><body><h1>Fixture checkout</h1><script>
    localStorage.setItem(${JSON.stringify(cacheKey)}, JSON.stringify({body:{access_token:'synthetic-fixture-token'},expiresAt:Date.now()/1000+600}));
    if(!localStorage.getItem('bigw:state-cartId')) localStorage.setItem('bigw:state-cartId',JSON.stringify('CT_browser_fixture'));
    document.cookie='bigw_location-store='+encodeURIComponent(JSON.stringify('0399'))+';Path=/;Secure';
    const fields={}; window.__fields=fields; addEventListener('message',e=>{if(e.origin===${JSON.stringify(fieldsOrigin)}) fields[e.data.type]=e.data.value;});
    async function pay(event){event.preventDefault();if(!fields.number||!fields.expiryDate||!fields.securityCode)throw Error('Secure fields were not filled');
      await fetch('https://api.bigw.com.au/storefront/v1/cart/${cart.id}/pay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cartId:${JSON.stringify(cart.id)},cartVersion:${cart.version + (tamperPayment ? 1 : 0)},transactions:{creditCardPaymentInfo:{sessionId:'fixture',amountInCents:${cart.total}}}})}).catch(()=>{});}
  </script><div data-testid="pay-with-new-card"><form onsubmit="pay(event)">
    ${['number', 'expiryDate', 'securityCode'].map(type => `<iframe title="Secure Input" src="${fieldsOrigin}/input.html?type=${type}&sessionId=fixture"></iframe>`).join('')}
    <button type="submit">Pay $22.00 with credit card</button></form></div></body></html>`;
}

async function intercept(request: HTTPRequest) {
  const url = new URL(request.url());
  if (url.origin === localOrigin || url.protocol === 'data:' || url.protocol === 'about:') {
    if (request.method() === 'POST') localActions.push(url.pathname);
    await request.continue({}, 0); return;
  }
  if (url.origin === fieldsOrigin) {
    const type = url.searchParams.get('type')!;
    await request.respond({ status: 200, contentType: 'text/html', body: `<form><label>${type}<input name="${type}" oninput='parent.postMessage({type:${JSON.stringify(type)},value:this.value},"https://www.bigw.com.au")'></label></form>` }, 0); return;
  }
  if (url.origin === 'https://www.bigw.com.au') {
    if (url.pathname.startsWith('/medias/')) { await request.respond({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="#b7c5a5"/></svg>' }, 0); return; }
    await request.respond({ status: 200, contentType: 'text/html', body: url.pathname === '/robots.txt' ? '<!doctype html><title>Static API bridge fixture</title>' : checkoutHtml() }, 0); return;
  }
  if (!['https://api.bigw.com.au', 'https://apix.bigw.com.au'].includes(url.origin)) { await request.abort('blockedbyclient', 0); return; }
  if (request.method() === 'OPTIONS') { await request.respond({ status: 204, headers: cors }, 0); return; }
  let body: unknown;
  if (url.pathname.includes('/product-price-api/v1/products')) body = fixtureProduct;
  else if (url.pathname.includes('/product-price-api/v1/prices/')) body = [{ price: { centAmount: 1800 }, label: 'PRE-ORDER' }];
  else if (url.pathname.includes('/warehouse-customer/')) body = [{ state: 'NSW', miraklZone: 'FIXTURE', zoneClassification: 'METRO' }];
  else if (url.pathname.includes('/availability/')) {
    if (holdAvailability) { availabilityStarted.emit('started'); await new Promise<void>(resolve => { releaseAvailability = resolve; }); }
    body = availability;
  } else if (url.pathname === '/profile/v1/addresses') body = [address];
  else if (url.pathname === '/profile/v1/profile') body = { name: { given: profile.firstName, family: profile.lastName }, phone: { mobile: '+61412345678' } };
  else if (url.pathname.endsWith('/saved-cards')) body = [{ id: 'fixture-saved-card', brand: 'VISA', last4: '1111' }];
  else if (url.pathname.endsWith('/pay')) {
    body = { orderNumber: `BW-FIXTURE-${paymentCount + 1}` };
  } else if (url.pathname.includes('/storefront/v1/cart/')) {
    const data = request.postData() ? JSON.parse(request.postData()!) : {};
    if (url.pathname.endsWith('/create')) cart = { ...cart, id: 'CT_new_fixture', entries: [{ productCode: data.productCode, quantity: data.quantity }] };
    if (url.pathname.endsWith('/update-details')) cart = { ...cart, deliveryAddress: data.deliveryAddress, customer: { firstName: data.firstName, lastName: data.lastName, phone: data.phone } };
    if (url.pathname.endsWith('/billing-address')) cart = { ...cart, billingAddress: data };
    if (url.pathname.endsWith('/recalculate')) cart.total = expensive ? 2700 : 2200;
    if (request.method() === 'POST') cart.version++;
    body = cart;
  } else { await request.abort('blockedbyclient', 0); throw new Error(`Unmapped test endpoint: ${url.pathname}`); }
  await request.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) }, 0);
}

async function waitForStatus(status: string) {
  await ui.waitForFunction(`(document.querySelector('.summary-heading .badge')?.textContent === ${JSON.stringify(status)} || document.querySelector('.summary-heading .badge')?.textContent === 'Stopped') && !document.querySelector('.checkout-form fieldset')?.disabled`, { timeout: 30_000, polling: 100 });
  assert.equal(await ui.$eval('.summary-heading .badge', element => element.textContent), status);
  await ui.bringToFront();
}

const retail = await browser.newPage();
await retail.setRequestInterception(true);
retail.on('request', request => intercept(request).catch(() => { if (!request.isInterceptResolutionHandled()) return request.abort('failed', 100); }));
retail.on('response', response => {
  if (new URL(response.url()).pathname.endsWith('/pay') && response.request().method() === 'POST') { paymentCount++; paymentBodies.push(response.request().postData() ?? ''); }
});
await retail.goto('https://www.bigw.com.au/checkout/delivery');
const ui = await browser.newPage();
await ui.setViewport({ width: 1440, height: 1000 });
await ui.setRequestInterception(true);
ui.on('request', request => intercept(request).catch(() => { if (!request.isInterceptResolutionHandled()) return request.abort('failed', 100); }));
const consoleErrors: string[] = [];
ui.on('pageerror', error => consoleErrors.push(String(error)));
retail.on('pageerror', error => consoleErrors.push(String(error)));

try {
  await ui.goto(localOrigin, { waitUntil: 'domcontentloaded' });
  await ui.waitForFunction(`document.querySelector('#profile-select')?.querySelectorAll('option').length === 2`, { polling: 100 });
  await ui.locator('.connection-button').click();
  await ui.waitForFunction(`document.querySelector('.connection-button')?.textContent.includes('Chrome connected')`, { timeout: 15_000, polling: 100 });
  await ui.bringToFront();
  await ui.locator('#field-productUrl').fill(productUrl);
  await ui.locator('#field-maxTotal').fill('25.00');
  await ui.locator('.inspect-button').click();
  await ui.waitForSelector('.product-preview img');
  await ui.locator('.primary-button').click();
  await waitForStatus('Checkout ready');
  assert.equal(paymentCount, 0, 'Prepare mode must never submit payment');
  console.log('PASS: full UI → API → real adapter → secure-fields preparation (intercepted retailer).');

  // Fill-only: the card is filled but never submitted, and the fields are kept.
  await ui.locator('.mode-option:nth-child(2)').click();
  await ui.locator('#field-card-number').fill(testCard.number);
  await ui.locator('#field-card-expiry').fill(testCard.expiry);
  await ui.locator('#field-card-cvv').fill(testCard.cvv);
  await ui.locator('.primary-button').click();
  await waitForStatus('Checkout ready');
  assert.equal(paymentCount, 0, 'Fill-only mode must never submit payment');
  await ui.bringToFront();
  assert.equal(await retail.evaluate(() => (window as unknown as { __fields?: { number?: string } }).__fields?.number), testCard.number.replace(/\s/g, ''), 'Fill-only must keep the card in the retailer fields');
  console.log('PASS: fill-only mode fills the card without submitting and keeps it.');

  await ui.locator('.mode-option:nth-child(3)').click();
  await ui.locator('#field-card-number').fill(testCard.number);
  await ui.locator('#field-card-expiry').fill(testCard.expiry);
  await ui.locator('#field-card-cvv').fill(testCard.cvv);
  await ui.locator('.primary-button').click();
  await waitForStatus('Order confirmed');
  assert.equal(paymentCount, 1);
  assert(!paymentBodies[0].includes(testCard.number), 'A new PAN must not be sent in the merchant payment body');
  assert(!paymentBodies[0].includes('securityCode'), 'A new-card CVV belongs in the secure fields, not the merchant body');
  assert.equal(await ui.$eval('#field-card-number', element => (element as HTMLInputElement).value), '');
  assert(!(await readFile(join(temporary, 'data/runs.json'), 'utf8')).includes(testCard.number));
  console.log('PASS: automatic new-card frame entry, one submission, confirmed result, secret clearing.');

  await ui.locator('.small-segment button:nth-child(2)').click();
  await ui.locator('.saved-card-bottom .text-button').click();
  await ui.waitForFunction(`document.querySelector('#saved-card')?.querySelectorAll('option').length === 2 || !!document.querySelector('.error-feedback')`, { polling: 100 });
  assert.equal(await ui.$$eval('#saved-card option', elements => elements.length), 2, await ui.$eval('body', element => element.querySelector('.error-feedback')?.textContent ?? 'Saved cards did not load'));
  await ui.select('#saved-card', 'fixture-saved-card');
  await ui.locator('#field-card-cvv').fill('321');
  await ui.locator('.primary-button').click();
  await ui.waitForFunction(`document.querySelector('.order-reference strong')?.textContent === 'BW-FIXTURE-2'`, { timeout: 30_000, polling: 100 });
  await ui.bringToFront();
  assert.equal(paymentCount, 2);
  console.log('PASS: saved-card transaction and CVV input.');

  tamperPayment = true;
  await ui.locator('#field-card-number').fill(testCard.number);
  await ui.locator('#field-card-expiry').fill(testCard.expiry);
  await ui.locator('#field-card-cvv').fill(testCard.cvv);
  await ui.locator('.primary-button').click();
  await waitForStatus('Stopped');
  assert.equal(paymentCount, 2, 'A changed outgoing cart version must be blocked before reaching the merchant');
  assert((await ui.$eval('.run-message', element => element.textContent ?? '')).includes('request was blocked'));
  tamperPayment = false;
  console.log('PASS: outgoing payment request binding blocks changed versions before transmission.');

  expensive = true;
  await ui.locator('.mode-option:first-child').click();
  await ui.locator('.primary-button').click();
  await waitForStatus('Stopped');
  assert.equal(paymentCount, 2, 'A changed total must not create a payment');
  assert((await ui.$eval('.run-message', element => element.textContent ?? '')).includes('above your'));
  console.log('PASS: authoritative delivered-budget guard.');
  expensive = false;

  holdAvailability = true;
  const began = new Promise<void>(resolve => availabilityStarted.once('started', resolve));
  await ui.locator('.primary-button').click();
  await began;
  await ui.locator('.cancel-button').click();
  releaseAvailability?.(); holdAvailability = false;
  await waitForStatus('Cancelled');
  assert.equal(paymentCount, 2);
  console.log('PASS: pre-payment cancellation.');

  await ui.setViewport({ width: 390, height: 844 });
  await ui.reload({ waitUntil: 'domcontentloaded' });
  await ui.waitForSelector('.checkout-form');
  assert(await ui.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile layout must not overflow horizontally');
  assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
  console.log('PASS: 390px mobile layout and no browser runtime errors.');
} catch (error) {
  console.error('Browser check diagnostics:', JSON.stringify({ connection: connection.state, activeRunId: manager.activeRunId, localActions, paymentCount, consoleErrors, runs: manager.history().map(run => ({ status: run.status, stage: run.stage, error: run.error, events: run.events })) }));
  console.error('Fixture frame readiness:', JSON.stringify(await Promise.all(retail.frames().map(async frame => ({ url: frame.url(), state: await frame.evaluate(() => ({ inputs: document.querySelectorAll('input').length, visibility: document.visibilityState, focused: document.hasFocus() })).catch(() => null) })))));
  console.error('Fixture UI state:', await ui.evaluate(() => ({ visibility: document.visibilityState, connection: document.querySelector('.connection-button')?.textContent, feedback: document.querySelector('.error-feedback')?.textContent, disabled: document.querySelector('fieldset')?.disabled })));
  throw error;
} finally {
  releaseAvailability?.();
  await connection.disconnect();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await browser.close();
  if (manager.activeRunId) await manager.wait(manager.activeRunId);
  await rm(temporary, { recursive: true, force: true });
}
