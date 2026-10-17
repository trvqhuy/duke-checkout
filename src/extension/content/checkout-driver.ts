// Stage-2 checkout driver content script. Injected into the BIG W checkout
// frame (www.bigw.com.au/checkout/*) and the Gr4vy secure-fields iframe
// (secure-fields.wpay2.gr4vy.app). The service worker drives it with
// chrome.tabs.sendMessage(tabId, msg, { frameId }); every handler is DOM-only
// and answers through return value / sendResponse. Ported from the CDP
// implementation in src/server/browser/payment.ts and the Afterpay hand-off in
// src/server/browser/bigw.ts so both drivers share READY, regexes, and click
// targets.

export function isFieldFrame(): boolean {
  return location.host === 'secure-fields.wpay2.gr4vy.app' && location.pathname === '/input.html';
}

export function isCheckoutFrame(): boolean {
  return location.host === 'www.bigw.com.au' && location.pathname.startsWith('/checkout/');
}

function fieldInput(): HTMLInputElement | null {
  return document.querySelector('input:not([type="hidden"])');
}

// Mirror payment.ts clear(): writing through the native prototype setter makes
// the framework-backed Gr4vy input treat the change as user input, and the
// bubbling input/change events let it re-validate and re-hydrate.
function setFieldValue(value: string): string {
  const input = fieldInput();
  if (!input) return '';
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.value;
}

function readFieldValue(): string {
  return fieldInput()?.value ?? '';
}

function handleField(type: string, value: unknown): unknown {
  if (type === 'driver.field.get') return { value: readFieldValue() };
  if (type === 'driver.field.set') return { value: setFieldValue(typeof value === 'string' ? value : '') };
  if (type === 'driver.field.clear') return { value: setFieldValue('') };
  return undefined;
}

function threeFieldCount(): number {
  return document.querySelectorAll('iframe[src*="secure-fields.wpay2.gr4vy.app/input.html"]').length;
}

function continueButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(node => /Continue to Payment/i.test(node.textContent || ''));
}

function handleReady(): unknown {
  const hasThreeFields = threeFieldCount() === 3;
  const hasSavedCards = !!document.querySelector('#saved-cards--nextgen');
  return { ready: hasThreeFields || hasSavedCards, hasThreeFields, hasSavedCards, continueButton: !!continueButton() };
}

function handleState(): unknown {
  const challenge = /3d.?secure|authenticate|challenge/i.test(location.pathname)
    || Array.from(document.querySelectorAll('iframe')).some(frame => /3ds|challenge/i.test(frame.src));
  return { url: location.href, challenge, confirmed: /thank you|order confirmed|order confirmation/i.test(document.body?.innerText || '') };
}

function clickContinueToPayment(): unknown {
  const button = continueButton();
  if (button && !button.disabled) { button.click(); return { clicked: true }; }
  return { clicked: false };
}

// Port of PaymentDriver.fill(): the checkout may open on the saved-card view,
// so switch to the new-card view to expose the secure inputs.
function clickNewCardView(): unknown {
  const radio = document.querySelector<HTMLInputElement>('input[name="savedOrNewCards"][value="false"]');
  if (radio) { radio.click(); return { clicked: true }; }
  const button = Array.from(document.querySelectorAll('button')).find(node => /new card/i.test(node.textContent || ''));
  if (button) { button.click(); return { clicked: true }; }
  return { clicked: false };
}

// Verbatim from PaymentDriver.submit()'s clickPay snippet.
function clickPay(): unknown {
  const form = document.querySelector('[data-testid="pay-with-new-card"] form');
  const button = (form && form.querySelector<HTMLButtonElement>('button[type="submit"]'))
    || Array.from(document.querySelectorAll('button')).find(node => /Pay .* with credit card/i.test(node.textContent || ''));
  if (button && !button.disabled) { button.click(); return { clicked: true }; }
  return { clicked: false };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Port of BigWAdapter.startAfterpay()'s selectAfterpay + clickPay loop. The
// Afterpay SDK mounts its button lazily, so the selection and the pay click are
// retried; the hand-off itself (redirect/popup) cannot be observed from a
// content script, so the click is repeated a few times and reported.
async function clickAfterpay(): Promise<unknown> {
  const tabs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"], label'));
  const selectAfterpay = () => {
    const tab = tabs().find(node => /afterpay/i.test(node.textContent || ''));
    if (!tab) return false;
    const target = tab.querySelector<HTMLElement>('input[type="radio"]') ?? tab.querySelector<HTMLElement>('[role="radio"]') ?? tab.querySelector<HTMLElement>('.option-toggle') ?? tab;
    target.click();
    return true;
  };
  const afterpayButton = () => Array.from(document.querySelectorAll('button')).find(node => /with afterpay/i.test(node.textContent || ''));
  let selected = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    selected = selectAfterpay() || selected;
    if (afterpayButton()) break;
    await delay(400);
  }
  const button = afterpayButton();
  if (!button) return { selected, clicked: false };
  let clicked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const pay = afterpayButton();
    if (pay && !pay.disabled) { pay.click(); clicked = true; }
    if (attempt < 2) await delay(600);
  }
  return { selected, clicked };
}

function handleCheckout(type: string): unknown | Promise<unknown> {
  if (type === 'driver.ready') return handleReady();
  if (type === 'driver.state') return handleState();
  if (type === 'driver.continueToPayment') return clickContinueToPayment();
  if (type === 'driver.newCardView') return clickNewCardView();
  if (type === 'driver.clickPay') return clickPay();
  if (type === 'driver.clickAfterpay') return clickAfterpay();
  return undefined;
}

// Shared implementation wrapped by the chrome.runtime listener and by
// __test.handle. Synchronous handlers return their object directly; the
// Afterpay handler returns a Promise because it retries on a timer.
export function handle(message: unknown): unknown | Promise<unknown> {
  const value = (message ?? {}) as { type?: unknown; value?: unknown };
  const type = typeof value.type === 'string' ? value.type : '';
  if (isFieldFrame()) return handleField(type, value.value);
  if (isCheckoutFrame()) return handleCheckout(type);
  return undefined;
}

export function notifyFieldsChanged(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
  void chrome.runtime.sendMessage({ type: 'driver.fieldsChanged' })?.catch?.(() => undefined);
}

// Rebuild awareness: the checkout recreates the Gr4vy iframes repeatedly, which
// discards typed values. Watching for iframe additions/removals lets the SW log
// and react. Throttled so a burst of DOM churn is at most one notification per
// 300 ms. `now` is injectable for deterministic tests.
export function observeRebuilds(target: Node = document.body, now: () => number = Date.now): MutationObserver | undefined {
  if (typeof MutationObserver === 'undefined' || !target) return undefined;
  let last = Number.NEGATIVE_INFINITY;
  const observer = new MutationObserver(records => {
    const iframeChanged = records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
      node.nodeType === 1 && ((node as Element).tagName === 'IFRAME' || !!(node as Element).querySelector?.('iframe'))));
    if (!iframeChanged) return;
    const timestamp = now();
    if (timestamp - last < 300) return;
    last = timestamp;
    notifyFieldsChanged();
  });
  observer.observe(target, { childList: true, subtree: true });
  return observer;
}

export function onMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  const result = handle(message);
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    void (result as Promise<unknown>).then(sendResponse, () => sendResponse(undefined));
    return true; // keep the channel open for the async reply
  }
  sendResponse(result);
  return false;
}

export const __test = { isFieldFrame, isCheckoutFrame, handle, notifyFieldsChanged, observeRebuilds, onMessage };

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(onMessage);
  if (isCheckoutFrame()) observeRebuilds();
}
