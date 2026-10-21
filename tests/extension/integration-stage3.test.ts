// Stage-3 end-to-end integration: the built unpacked extension (dist-extension/)
// exercises the trigger surface end to end — the hover chip injected into a
// FOREIGN (non-BIG W) page, chip Arm, auto-arm on product-page navigation, the
// internal trigger dispatch (the exact message the context-menu / keyboard
// command handlers send), and the onboarding hand-off for an unconfigured
// browser.
//
// The BIG W document, API, checkout page, and guarded /pay are served by the
// Stage-2 fixture (fixture-retailer.ts) through request interception on the work
// tab. The foreign page is served by a real node:http server on 127.0.0.1 so the
// `<all_urls>` link-scout content script actually injects into it.
//
// Prerequisite: `npm run build:ext` (asserted below with a clear message).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import type { Browser, Page } from 'puppeteer-core';
import {
  RetailerFixture, assertExtensionBuilt, PRODUCT_CODE,
  launchExtensionBrowser, makeTemporaryDir, interceptNewTabs, profile, testCard, waitForBridgePing, findOrOpenAppTab, keepOnlyAppTab,
} from './fixture-retailer.ts';

// The link the foreign page points at; the fixture answers code 6071620. It has
// the same product code as the fixture product URL but a different slug, proving
// the trigger reads the anchor's href rather than the page URL.
const FOREIGN_PRODUCT_URL = 'https://www.bigw.com.au/product/example/p/6071620';

// Exactly the settings the app writes and the service worker reads.
const SETTINGS = {
  quantity: 1, maxTotalAUD: '1000.00', mode: 'purchase' as const,
  confirmBeforePay: false, hoverChip: true, autoArm: false, cardClearAfterOrder: false,
};

// A foreign page with one BIG W product anchor. Nothing here is a BIG W origin,
// so only link-scout (matches <all_urls>) is injected.
const FOREIGN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Foreign retailer</title></head>
<body><h1>Deals elsewhere</h1>
<a href="${FOREIGN_PRODUCT_URL}" id="product-link">Great deal</a>
</body></html>`;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let temporary: string;
let browser: Browser;
let extensionId: string;
let appPage: Page;
let workPage: Page;
let foreignPage: Page;
let foreignServer: Server;
let foreignUrl: string;
const fixture = new RetailerFixture();

interface RunRecord {
  id: string;
  status: string;
  productCode: string;
  quantity: number;
  orderNumber?: string;
  error?: { code: string; message: string };
}

interface ArmedRecord { productCode?: string; productUrl?: string }

async function sendToBackground<T>(type: string, payload: unknown = null): Promise<T> {
  return appPage.evaluate(async (message) => {
    const response = await chrome.runtime.sendMessage({ id: crypto.randomUUID(), ...message });
    return response?.ok ? response.result : null;
  }, { type, payload }) as Promise<T>;
}

async function runList(): Promise<RunRecord[]> {
  return (await sendToBackground<RunRecord[]>('run.list')) ?? [];
}

// Wait for a terminal run for `productCode` that was not present before the
// action (guards against a stale run from an earlier scenario matching).
async function waitForNewTerminalRun(productCode: string, beforeIds: Set<string>, timeout = 90_000): Promise<RunRecord> {
  const terminal = ['succeeded', 'failed', 'cancelled', 'payment_unknown', 'ready'];
  const deadline = Date.now() + timeout;
  let last: RunRecord[] = [];
  while (Date.now() < deadline) {
    last = await runList();
    const run = last.find(item => item.productCode === productCode && terminal.includes(item.status) && !beforeIds.has(item.id));
    if (run) return run;
    await sleep(500);
  }
  throw new Error(`No new terminal run for ${productCode} appeared. Runs: ${JSON.stringify(last)}`);
}

// Only the keys actually provided are touched: an omitted key is left alone,
// while an explicit null removes it (so a scenario can clear just the profile).
async function seedState(state: { settings?: typeof SETTINGS; profile?: typeof profile | null; card?: { number: string; expiry: string; cvv: string } | null }): Promise<void> {
  await appPage.evaluate(async (input) => {
    if (input.settings !== undefined) await chrome.storage.local.set({ dukeSettings: input.settings });
    if (input.profile !== undefined) {
      if (input.profile) await chrome.storage.local.set({ dukeProfile: input.profile });
      else await chrome.storage.local.remove('dukeProfile');
    }
    if (input.card !== undefined) {
      if (input.card) await chrome.storage.session.set({ dukeCard: input.card });
      else await chrome.storage.session.remove('dukeCard');
    }
    await chrome.storage.session.remove('dukeArmed');
  }, state);
}

async function sessionArmed(): Promise<ArmedRecord | null> {
  return appPage.evaluate(async () => {
    const stored = await chrome.storage.session.get(['dukeArmed']);
    return (stored.dukeArmed ?? null) as { productCode?: string; productUrl?: string } | null;
  });
}

interface OpenTab { id: number; url: string; active: boolean }
async function openTabs(): Promise<OpenTab[]> {
  return appPage.evaluate(async () => (await chrome.tabs.query({})).map(tab => ({ id: tab.id!, url: tab.url ?? '', active: !!tab.active })));
}

// A successful run leaves its presentation tab on the BIG W checkout. Close it
// between scenarios so acquireWorkTab cannot pick a stale checkout from the
// previous test.
async function closeExtraWorkTabs(): Promise<void> {
  const ids = (await openTabs()).filter(tab => tab.url.includes('bigw.com.au/checkout/')).map(tab => tab.id);
  if (!ids.length) return;
  await appPage.evaluate(async (tabIds) => { await Promise.all(tabIds.map(id => chrome.tabs.remove(id).catch(() => undefined))); }, ids).catch(() => undefined);
}

async function waitForArmed(productCode: string, timeout = 40_000): Promise<ArmedRecord> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const armed = await sessionArmed();
    if (armed?.productCode === productCode) return armed;
    await sleep(400);
  }
  throw new Error(`dukeArmed for ${productCode} never appeared in chrome.storage.session`);
}

// --- hover chip plumbing ----------------------------------------------------
// link-scout attaches an UNIDENTIFIED host div to document.documentElement and
// opens its shadow root (mode: 'open'), so the chip is found by scanning for the
// one element whose shadow root carries `.duke-chip`.

async function chipPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => Array.from(document.querySelectorAll('*'))
    .some(element => !!element.shadowRoot?.querySelector('.duke-chip')));
}

// A trusted pointer move: CDP Input produces a real (isTrusted) mouseover, the
// only kind the chip now accepts. A synthetic dispatchEvent would be ignored.
async function hoverProductLink(page: Page, selector: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const point = await page.$eval(selector, (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await sleep(400); // clears the chip's 200 ms show delay
    if (await chipPresent(page)) return;
  }
  throw new Error(`hover chip never appeared after hovering ${selector}`);
}

// Reads the button's viewport centre through the chip's (open) shadow root; it
// does not click. Used by the trusted click path and the synthetic-click test.
async function chipButtonCenter(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.evaluate((target) => {
    const host = Array.from(document.querySelectorAll('*'))
      .find(element => !!element.shadowRoot?.querySelector('.duke-chip'));
    const button = host?.shadowRoot?.querySelector(target) as HTMLElement | null;
    if (!button) throw new Error(`chip button ${target} not found inside the shadow root`);
    const rect = button.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) throw new Error(`chip button ${target} has no clickable area`);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
}

// A real user click: page.mouse.click drives CDP Input, so the chip button sees
// an isTrusted click — exactly the gesture the guard requires.
async function clickChip(page: Page, selector: string): Promise<void> {
  const { x, y } = await chipButtonCenter(page, selector);
  await page.mouse.click(x, y);
}

// What a hostile page script can do: element.click() yields isTrusted:false.
async function syntheticClickChip(page: Page, selector: string): Promise<void> {
  await page.evaluate((target) => {
    const host = Array.from(document.querySelectorAll('*'))
      .find(element => !!element.shadowRoot?.querySelector('.duke-chip'));
    const button = host?.shadowRoot?.querySelector(target);
    if (!button) throw new Error(`chip button ${target} not found inside the shadow root`);
    (button as HTMLElement).click();
  }, selector);
}

async function chipText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = Array.from(document.querySelectorAll('*'))
      .find(element => !!element.shadowRoot?.querySelector('.duke-chip'));
    return host?.shadowRoot?.textContent ?? '';
  });
}

beforeAll(async () => {
  assertExtensionBuilt();
  temporary = await makeTemporaryDir('duke-extension-stage3-');
  ({ browser, extensionId } = await launchExtensionBrowser(temporary));
  // The work tab exists before any SW acquire with interception already attached.
  workPage = await browser.newPage();
  await workPage.setRequestInterception(true);
  workPage.on('request', request => fixture.intercept(request).catch(async () => { if (!request.isInterceptResolutionHandled()) return request.abort('failed', 100); }));
  await interceptNewTabs(browser, fixture);
  workPage.on('pageerror', error => fixture.runtimeErrors.push(`work pageerror: ${String(error)}`));
  await workPage.goto('https://www.bigw.com.au/', { waitUntil: 'load' });

  appPage = await findOrOpenAppTab(browser, extensionId);
  appPage.on('pageerror', error => fixture.runtimeErrors.push(`app pageerror: ${String(error)}`));
  await appPage.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: 'domcontentloaded' });
  await appPage.waitForSelector('#field-quantity', { timeout: 20_000 });
  await waitForBridgePing(appPage);

  // A real local HTTP origin for the foreign page, so link-scout injects.
  foreignServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(FOREIGN_HTML);
  });
  await new Promise<void>(resolve => foreignServer.listen(0, '127.0.0.1', resolve));
  foreignUrl = `http://127.0.0.1:${(foreignServer.address() as AddressInfo).port}/`;
  foreignPage = await browser.newPage();
  foreignPage.on('pageerror', error => fixture.runtimeErrors.push(`foreign pageerror: ${String(error)}`));
  await foreignPage.goto(foreignUrl, { waitUntil: 'load' });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => foreignServer?.close(() => resolve()));
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

beforeEach(async () => {
  fixture.reset();
  await appPage.bringToFront();
  // Drop any armed checkout (cache + session storage) so each scenario starts
  // from an unarmed state, then seed a configured browser.
  await sendToBackground('arm.clear');
  await closeExtraWorkTabs();
  await seedState({ settings: SETTINGS, profile, card: { number: testCard.number, expiry: testCard.expiry, cvv: testCard.cvv } });
  // Reset the work tab to the BIG W root (seeds the Auth0 cache; the bridge
  // answers again) and the foreign page (fresh link-scout settings cache).
  await workPage.goto('https://www.bigw.com.au/', { waitUntil: 'load' });
  await foreignPage.goto(foreignUrl, { waitUntil: 'load' });
  await appPage.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: 'domcontentloaded' });
  await keepOnlyAppTab(browser, appPage, extensionId);
  await appPage.waitForSelector('#field-quantity', { timeout: 20_000 });
}, 60_000);

describe('extension stage-3 integration', () => {
  it('chip one-click on a foreign page starts and completes a run with exactly one /pay', async () => {
    const beforeIds = new Set((await runList()).map(run => run.id));
    await foreignPage.bringToFront();
    await hoverProductLink(foreignPage, '#product-link');
    await clickChip(foreignPage, '.duke-chip-checkout');

    // The trigger opens a progress tab BEFORE the run starts. That same tab is
    // then navigated to the retailer checkout — never the settings page, never
    // a second tab appearing at the end.
    let progressTab: OpenTab | undefined;
    const progressDeadline = Date.now() + 8_000;
    while (Date.now() < progressDeadline && !progressTab) {
      progressTab = (await openTabs()).find(tab => tab.url.includes('/progress.html?request='));
      if (!progressTab) await sleep(50);
    }
    expect(progressTab, JSON.stringify(await openTabs())).toBeDefined();
    expect(progressTab!.active).toBe(true);

    const run = await waitForNewTerminalRun(PRODUCT_CODE, beforeIds);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(run.orderNumber).toBe('ORD-1');
    expect(fixture.payPosts).toBe(1);

    const tabs = await openTabs();
    const checkout = tabs.find(tab => tab.url.includes('/checkout/'));
    expect(checkout?.id).toBe(progressTab!.id);
    // The extension's own page never appears as part of a checkout.
    expect(tabs.filter(tab => tab.url.includes('/app.html')).length).toBe(1);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);

  it('chip quantity reaches the run and the cart', async () => {
    const beforeIds = new Set((await runList()).map(run => run.id));
    await foreignPage.bringToFront();
    await hoverProductLink(foreignPage, '#product-link');
    // A real trusted click on the stepper, then checkout.
    const plus = await chipButtonCenter(foreignPage, '.duke-qty-plus');
    await foreignPage.mouse.click(plus.x, plus.y);
    await sleep(100);
    expect(await chipText(foreignPage)).toContain('2');
    await clickChip(foreignPage, '.duke-chip-checkout');

    const run = await waitForNewTerminalRun(PRODUCT_CODE, beforeIds);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(run.quantity).toBe(2);
    expect(fixture.payPosts).toBe(1);
    // The chip remembers the choice as the new default for the next hover.
    const stored = await appPage.evaluate(async () => (await chrome.storage.local.get(['dukeSettings'])).dukeSettings) as { quantity?: number };
    expect(stored.quantity).toBe(2);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);

  it('a chip checkout without a card stays in place and offers setup', async () => {
    await seedState({ card: null });
    const before = await openTabs();
    const beforeRuns = new Set((await runList()).map(run => run.id));
    await foreignPage.bringToFront();
    await hoverProductLink(foreignPage, '#product-link');
    await clickChip(foreignPage, '.duke-chip-checkout');

    await foreignPage.waitForFunction(() => {
      const host = Array.from(document.querySelectorAll('*')).find(element => !!element.shadowRoot?.querySelector('.duke-chip'));
      return (host?.shadowRoot?.textContent ?? '').includes('Add a card');
    }, { timeout: 10_000, polling: 100 });
    const text = await chipText(foreignPage);
    expect(text).toContain('Open Duke setup');
    // No progress tab, no settings hijack, no run.
    const after = await openTabs();
    expect(after.map(tab => tab.id).sort()).toEqual(before.map(tab => tab.id).sort());
    expect((await runList()).filter(run => !beforeRuns.has(run.id))).toEqual([]);
    expect(fixture.payPosts).toBe(0);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 60_000);

  it('the progress tab can cancel a run before payment', async () => {
    fixture.delayCreateMs = 3_000;
    const beforeIds = new Set((await runList()).map(run => run.id));
    await foreignPage.bringToFront();
    await hoverProductLink(foreignPage, '#product-link');
    await clickChip(foreignPage, '.duke-chip-checkout');

    let progressPage: Page | undefined;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !progressPage) {
      progressPage = (await browser.pages()).find(page => page.url().includes('/progress.html'));
      if (!progressPage) await sleep(100);
    }
    expect(progressPage, 'progress tab was not opened').toBeTruthy();
    await progressPage!.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll('#actions button')).find(element => element.textContent === 'Cancel');
      return !!button;
    }, { timeout: 10_000, polling: 100 });
    await progressPage!.evaluate(() => {
      const button = Array.from(document.querySelectorAll('#actions button')).find(element => element.textContent === 'Cancel') as HTMLButtonElement | undefined;
      button?.click();
    });

    const run = await waitForNewTerminalRun(PRODUCT_CODE, beforeIds);
    expect(run.status).toBe('cancelled');
    expect(fixture.payPosts).toBe(0);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 90_000);

  it('chip Arm stores dukeArmed for the product and starts no run', async () => {
    const beforeIds = new Set((await runList()).map(run => run.id));
    await foreignPage.bringToFront();
    await hoverProductLink(foreignPage, '#product-link');
    await clickChip(foreignPage, '.duke-chip-arm');

    const armed = await waitForArmed(PRODUCT_CODE);
    expect(armed.productUrl).toBe(FOREIGN_PRODUCT_URL);
    const after = new Set((await runList()).map(run => run.id));
    expect([...after].filter(id => !beforeIds.has(id))).toEqual([]);
    expect(fixture.payPosts).toBe(0);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);

  it('rejects a synthetic chip click on a foreign page — no run starts', async () => {
    const beforeIds = new Set((await runList()).map(run => run.id));
    await foreignPage.bringToFront();
    await hoverProductLink(foreignPage, '#product-link');
    // The chip is up, but this is what a hostile page can do: page-script .click().
    await syntheticClickChip(foreignPage, '.duke-chip-checkout');
    await sleep(1_500);
    const after = new Set((await runList()).map(run => run.id));
    expect([...after].filter(id => !beforeIds.has(id))).toEqual([]);
    expect(fixture.payPosts).toBe(0);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 60_000);

  it('auto-arm on product-page navigation arms after the debounce with no click', async () => {
    await seedState({ settings: { ...SETTINGS, autoArm: true } });
    await workPage.goto(FOREIGN_PRODUCT_URL, { waitUntil: 'load' });

    const armed = await waitForArmed(PRODUCT_CODE, 40_000);
    expect(armed.productUrl).toBe(FOREIGN_PRODUCT_URL);
    expect(fixture.payPosts).toBe(0);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);

  it('internal trigger dispatch (menu/shortcut equivalent) arms via trigger.arm', async () => {
    // The OS-level context menu and Chrome keyboard shortcut UI cannot be driven
    // from CDP, so this sends the exact message the menu/command handlers
    // dispatch; the SW path (decode → trigger listener → dispatchTrigger → arm)
    // is identical to the real UI's.
    await appPage.evaluate(async (url) => { await chrome.runtime.sendMessage({ type: 'trigger.arm', url }); }, FOREIGN_PRODUCT_URL);

    const armed = await waitForArmed(PRODUCT_CODE);
    expect(armed.productUrl).toBe(FOREIGN_PRODUCT_URL);
    expect(fixture.payPosts).toBe(0);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);

  it('an unconfigured checkout is answered in place and never hijacks the app tab', async () => {
    await seedState({ profile: null });
    const before = await openTabs();
    const beforeRuns = new Set((await runList()).map(run => run.id));
    const result = await appPage.evaluate(async (url) => {
      return await chrome.runtime.sendMessage({ type: 'trigger.checkout', url, quantity: 2 }) as { ok?: boolean; code?: string } | undefined;
    }, FOREIGN_PRODUCT_URL);
    expect(result).toMatchObject({ ok: false, code: 'PROFILE_REQUIRED' });
    // No onboarding navigation, no progress tab, no run.
    const after = await openTabs();
    expect(after.map(tab => tab.id).sort()).toEqual(before.map(tab => tab.id).sort());
    expect(appPage.url()).toContain('/app.html');
    expect(appPage.url()).not.toContain('onboarding=1');
    expect((await runList()).filter(run => !beforeRuns.has(run.id))).toEqual([]);
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 60_000);

  it('the setup page imports the BIG W profile and persists it', async () => {
    await seedState({ profile: null });
    await appPage.goto(`chrome-extension://${extensionId}/app.html?onboarding=1`, { waitUntil: 'domcontentloaded' });
    await appPage.waitForSelector('#field-quantity', { timeout: 20_000 });
    await appPage.waitForSelector('.onboarding-panel', { timeout: 20_000 });
    await appPage.evaluate(() => {
      const button = Array.from(document.querySelectorAll('.onboarding-panel button'))
        .find(element => element.textContent?.includes('Import my BIG W profile'));
      if (!button) throw new Error('Import my BIG W profile button not found');
      (button as HTMLButtonElement).click();
    });

    await appPage.waitForFunction((firstName) => {
      const input = document.querySelector('#field-firstName') as HTMLInputElement | null;
      return input?.value === firstName;
    }, { timeout: 30_000, polling: 250 }, profile.firstName);

    const stored = await appPage.evaluate(async () => (await chrome.storage.local.get(['dukeProfile'])).dukeProfile);
    expect(stored).toMatchObject({
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: '+61412345678',
      deliveryAddress: {
        line1: profile.deliveryAddress.line1,
        suburb: profile.deliveryAddress.suburb,
        postcode: profile.deliveryAddress.postcode,
        state: 'NSW',
      },
    });
    expect(fixture.runtimeErrors, fixture.runtimeErrors.join('\n')).toEqual([]);
  }, 120_000);
});
