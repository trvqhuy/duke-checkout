// Stage-2 end-to-end integration: the built unpacked extension (dist-extension/)
// drives a real checkout through the fixture retailer — purchase, decline,
// fill-only (assist), cancel, and the MAIN-world guard's duplicate fence.
//
// The work tab is created by the test with request interception attached before
// the service worker ever queries tabs, so the checkout page, the Gr4vy
// secure-field frames, and the guarded /pay call are all served deterministically.
// Prerequisite: `npm run build:ext` (asserted below with a clear message).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import type { Browser, Page } from 'puppeteer-core';
import {
  RetailerFixture, assertExtensionBuilt, CART_ID, PRODUCT_CODE, extensionDir,
  launchExtensionBrowser, makeTemporaryDir, profile, productUrl, readSecureFieldValues, testCard, waitForBridgePing,
} from './fixture-retailer.ts';

let temporary: string;
let browser: Browser;
let extensionId: string;
let appPage: Page;
let workPage: Page;
const fixture = new RetailerFixture();

const CARD_PATHS = [testCard.number, testCard.expiry, testCard.cvv];

async function panelRunId(): Promise<string | null> {
  return appPage.$eval('.run-progress', element => element.getAttribute('data-run-id')).catch(() => null);
}

// Poll the run panel for a terminal status. `differentFrom` guards against a
// stale panel from a previous run matching before the new run's panel appears.
async function waitForRunStatus(status: string, differentFrom: string | null, timeout = 90_000): Promise<void> {
  await appPage.waitForFunction(
    (want: { status: string; differentFrom: string | null }) => {
      const panel = document.querySelector('.run-progress');
      if (!panel) return false;
      if (want.differentFrom && panel.getAttribute('data-run-id') === want.differentFrom) return false;
      return panel.classList.contains(want.status);
    },
    { timeout, polling: 250 },
    { status, differentFrom },
  );
}

async function clickStartAndWait(status: string, timeout = 90_000): Promise<string | null> {
  const before = await panelRunId();
  await appPage.locator('.start-button').click();
  await waitForRunStatus(status, before, timeout);
  return panelRunId();
}

async function sendToBackground<T>(type: string, payload: unknown = null): Promise<T> {
  return appPage.evaluate(async (message) => {
    const response = await chrome.runtime.sendMessage({ id: crypto.randomUUID(), ...message });
    return response?.ok ? response.result : null;
  }, { type, payload }) as Promise<T>;
}

interface RunRecord {
  id: string;
  status: string;
  productCode: string;
  orderNumber?: string;
  error?: { code: string; message: string };
}

// Fill the whole start form (settings, profile, product, card) and wait until
// the start button is enabled.
async function prepareForm(mode: 'purchase' | 'assist', budget = '25.00'): Promise<void> {
  await appPage.locator(`button[data-mode="${mode}"]`).click();
  await appPage.locator('#field-firstName').fill(profile.firstName);
  await appPage.locator('#field-lastName').fill(profile.lastName);
  await appPage.locator('#field-phone').fill(profile.phone);
  await appPage.locator('#field-deliveryAddress-line1').fill(profile.deliveryAddress.line1);
  await appPage.locator('#field-deliveryAddress-suburb').fill(profile.deliveryAddress.suburb);
  await appPage.select('#deliveryAddress-state', 'NSW');
  await appPage.locator('#field-deliveryAddress-postcode').fill(profile.deliveryAddress.postcode);
  await appPage.locator('#field-productUrl').fill(productUrl);
  await appPage.locator('#field-quantity').fill('1');
  await appPage.locator('#field-maxTotalAUD').fill(budget);
  await appPage.locator('#field-card-number').fill(testCard.number);
  await appPage.locator('#field-card-expiry').fill(testCard.expiry);
  await appPage.locator('#field-card-cvv').fill(testCard.cvv);
  await appPage.waitForFunction(() => {
    const button = document.querySelector('.start-button') as HTMLButtonElement | null;
    return !!button && !button.disabled;
  }, { timeout: 15_000, polling: 150 });
}

async function storageDump(): Promise<string> {
  return appPage.evaluate(async () => JSON.stringify({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null),
  }));
}

beforeAll(async () => {
  assertExtensionBuilt();
  temporary = await makeTemporaryDir('duke-extension-stage2-');
  ({ browser, extensionId } = await launchExtensionBrowser(temporary));
  // The work tab exists before any SW acquire: acquireWorkTab() reuses it, and
  // interception is already attached, so every retailer request is served.
  workPage = await browser.newPage();
  await workPage.setRequestInterception(true);
  workPage.on('request', request => fixture.intercept(request).catch(async () => { if (!request.isInterceptResolutionHandled()) return request.abort('failed', 100); }));
  workPage.on('pageerror', error => fixture.runtimeErrors.push(`work pageerror: ${String(error)}`));
  await workPage.goto('https://www.bigw.com.au/', { waitUntil: 'load' });
  appPage = await browser.newPage();
  appPage.on('pageerror', error => fixture.runtimeErrors.push(`app pageerror: ${String(error)}`));
  await appPage.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: 'domcontentloaded' });
  await appPage.waitForSelector('#field-quantity', { timeout: 20_000 });
  await waitForBridgePing(appPage);
}, 90_000);

afterAll(async () => {
  await browser?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture.reset();
  // The run foregrounds the work tab; bring the app tab back so Puppeteer can
  // drive its form (visibility waits do not resolve on a background tab).
  await appPage.bringToFront();
  // Drop any armed checkout so every run takes the full prepare path, and clear
  // the one-run card fields the app may have kept from a prior scenario.
  await sendToBackground('arm.clear');
  await appPage.locator('#field-card-number').fill('');
  await appPage.locator('#field-card-expiry').fill('');
  await appPage.locator('#field-card-cvv').fill('');
  await workPage.goto('https://www.bigw.com.au/', { waitUntil: 'load' });
}, 30_000);

describe('extension stage-2 integration', () => {
  it('purchase confirmed: the page\'s own guarded /pay is allowed and the order reference renders', async () => {
    await prepareForm('purchase');
    const runId = await clickStartAndWait('succeeded');
    expect(runId).toBeTruthy();

    const order = await appPage.$eval('.order-reference strong', element => element.textContent);
    expect(order).toBe('ORD-1');

    // The fixture only returns ORD-1 from its /pay handler, and the MAIN-world
    // guard only forwards the page's fetch when checkPaymentRequest passes — so
    // a confirmed run proves the guard allowed the page's own request.
    expect(fixture.payPosts).toBe(1);
    expect(fixture.requestedPaths).toContain(`/storefront/v1/cart/${CART_ID}/pay`);
    const body = fixture.payBodies[0];
    expect(body).toMatchObject({
      cartId: CART_ID,
      transactions: { creditCardPaymentInfo: { amountInCents: 2200, sessionId: 'SESSION_FIXTURE', storePaymentMethod: false } },
    });
    expect(typeof body.cartVersion).toBe('number');

    const runs = await sendToBackground<RunRecord[]>('run.list');
    const run = runs.find(item => item.id === runId)!;
    expect(run).toMatchObject({ status: 'succeeded', orderNumber: 'ORD-1' });

    // No card material lingers in either storage area (the run keeps the card in
    // its in-memory payload only; sanitizeRun strips it from history/session).
    const dump = await storageDump();
    for (const secret of CARD_PATHS) expect(dump).not.toContain(secret);
    expect(dump).not.toContain('"cvv"');
    expect(dump.toLowerCase()).not.toContain('securitycode');

    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);

  it('declined: a 409 INVALID_PAYMENT fails the run with PAYMENT_DECLINED', async () => {
    fixture.payResponse = 'declined';
    await prepareForm('purchase');
    const runId = await clickStartAndWait('failed');

    const message = await appPage.$eval('.run-message.message-error', element => element.textContent ?? '');
    expect(message.toLowerCase()).toContain('rejected the payment');

    const runs = await sendToBackground<RunRecord[]>('run.list');
    const run = runs.find(item => item.id === runId)!;
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('PAYMENT_DECLINED');

    expect(fixture.payPosts).toBe(1);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);

  it('assist: fill-only reaches ready with the card in the secure frames and never sends /pay', async () => {
    await prepareForm('assist');
    await clickStartAndWait('ready');

    const values = await readSecureFieldValues(workPage);
    expect(values).toEqual({ number: testCard.number, expiryDate: testCard.expiry, securityCode: testCard.cvv });
    expect(fixture.payPosts).toBe(0);
    expect(fixture.requestedPaths.some(path => path.endsWith('/pay'))).toBe(false);

    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);

  it('cancel: cancelling while preparing ends the run cancelled with no /pay submitted', async () => {
    fixture.delayCreateMs = 3000; // hold the run inside cart preparation
    await prepareForm('purchase');
    const before = await panelRunId();
    await appPage.locator('.start-button').click();
    await appPage.waitForSelector('.run-progress .cancel-button', { timeout: 30_000 });
    await appPage.locator('.run-progress .cancel-button').click();
    await waitForRunStatus('cancelled', before, 60_000);

    expect(fixture.payPosts).toBe(0);
    expect(fixture.requestedPaths.some(path => path.endsWith('/pay'))).toBe(false);

    const runs = await sendToBackground<RunRecord[]>('run.list');
    const latest = runs.find(item => item.productCode === PRODUCT_CODE)!;
    expect(latest.status).toBe('cancelled');

    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);

  it('guard duplicate: a page that fires /pay twice only reaches the endpoint once', async () => {
    fixture.duplicatePay = true;
    await prepareForm('purchase');
    await clickStartAndWait('succeeded');

    expect(fixture.payPosts).toBe(1);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);
});
