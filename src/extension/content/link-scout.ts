// ---------------------------------------------------------------------------
// link-scout — the hover card (Stage 3, Task 1; rewritten for Stage 5)
// ---------------------------------------------------------------------------
// It watches every page for BIG W product links and offers a small card with a
// quantity stepper, "Checkout now", "Arm", and a settings shortcut. A tiny
// "Duke" badge is painted next to product links (CSS only, no DOM injection
// into the anchor) so the feature is discoverable on search pages.
//
// It never performs checkout work itself; it sends trigger.* intents to the
// service worker. The service worker answers with a structured result:
//   { ok: true }                        → a progress tab is opening
//   { ok: false, code, message }        → rendered in place, with the fix
// A click is therefore never silently dropped into a desktop notification.
//
// MESSAGE-NAMESPACE OWNERSHIP (who is allowed to answer what)
//   bridge.*  → the ISOLATED relay (api-bridge-isolated) is the ONLY responder.
//   driver.*  → the checkout driver (checkout-driver) is the ONLY responder.
//   trigger.* → service-worker trigger handlers consume these and respond.
//   This file only LISTENS for `settings.update` (returns false, never claims a
//   response channel) so it cannot race another content script's reply.
//
// Constraints: page DOM is not mutated outside our own shadow host and one
// scoped <style> element for the inline badges; anchor clicks are never
// intercepted (no preventDefault), so normal navigation is untouched.
// ---------------------------------------------------------------------------

// The product-link predicate lives in lib/ so the service worker can import it
// without pulling in this content script; re-exported here to keep the chip's
// existing surface (and the __test export below) intact.
import { isProductUrl } from '../lib/product-url.ts';
export { isProductUrl } from '../lib/product-url.ts';

interface ScoutSettings { hoverChip: boolean; inlineBadges: boolean; quantity: number }
const DEFAULT_SETTINGS: ScoutSettings = { hoverChip: true, inlineBadges: true, quantity: 1 };
const SHOW_DELAY_MS = 200;
const HIDE_GRACE_MS = 120;
const BADGE_ATTR = 'data-duke-badges';

// Settings are read lazily on first need and cached; chrome.storage.onChanged
// keeps the cache fresh. When storage is unavailable or unreadable the default
// (chip on) is used so the feature is never silently disabled by a broken
// environment.
let settings: ScoutSettings | null = null;
let storageListenerAttached = false;

// A content script can run on any origin, including plain http pages where
// crypto.randomUUID is unavailable (secure-context only). The RPC only needs a
// unique string.
function messageId(): string {
  try { return crypto.randomUUID(); } catch { return `duke-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function normalizeSettings(raw: unknown): ScoutSettings {
  const value = (raw ?? {}) as { hoverChip?: unknown; inlineBadges?: unknown; quantity?: unknown };
  const quantity = Math.round(Number(value.quantity));
  return {
    hoverChip: typeof value.hoverChip === 'boolean' ? value.hoverChip : true,
    inlineBadges: typeof value.inlineBadges === 'boolean' ? value.inlineBadges : true,
    quantity: Number.isFinite(quantity) ? Math.min(20, Math.max(1, quantity)) : 1,
  };
}

async function requestSettings(): Promise<ScoutSettings | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return null;
    const response = await chrome.runtime.sendMessage({ id: messageId(), type: 'settings.get', payload: null }) as { ok?: boolean; result?: unknown } | undefined;
    return response?.ok ? normalizeSettings(response.result) : null;
  } catch { return null; }
}

function loadSettings(): Promise<ScoutSettings> {
  // storage.local is locked to trusted contexts (the worker and extension
  // pages) so a content script may be denied. Fall back to the settings.get RPC
  // the worker exposes. The direct read is kept first because it is cheap and
  // works in hosts (and tests) that do not apply an access level.
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      return Promise.resolve(chrome.storage.local.get(['dukeSettings']))
        .then(items => normalizeSettings((items as Record<string, unknown> | undefined)?.dukeSettings))
        .catch(() => requestSettings().then(value => value ?? DEFAULT_SETTINGS));
    }
  } catch { /* fall through to the RPC */ }
  return requestSettings().then(value => value ?? DEFAULT_SETTINGS);
}

function applySettings(next: ScoutSettings): void {
  settings = next;
  // A settings change may turn the inline badges on or off while the page is
  // open; keep the page in step without a reload.
  syncBadges();
  if (!settings.hoverChip) hideChip();
}

function attachStorageListener(): void {
  if (storageListenerAttached) return;
  storageListenerAttached = true;
  // storage.onChanged is scoped to areas this context can read; the worker also
  // pushes settings.update to every tab so a locked storage area cannot leave
  // an open page with stale toggles.
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area && area !== 'local') return;
      const change = (changes as Record<string, { newValue?: unknown }>).dukeSettings;
      if (!change) return;
      applySettings(normalizeSettings(change.newValue));
    });
  } catch { /* storage events unavailable */ }
  try {
    chrome.runtime?.onMessage?.addListener((raw: unknown) => {
      const message = raw as { type?: string; payload?: unknown } | null;
      if (message?.type === 'settings.update') applySettings(normalizeSettings(message.payload));
      // Never claim a response channel: trigger.* replies belong to the worker.
      return false;
    });
  } catch { /* runtime events unavailable */ }
}

function ensureSettings(): Promise<ScoutSettings> {
  if (settings) return Promise.resolve(settings);
  return loadSettings().then(value => {
    settings ??= value;
    attachStorageListener();
    syncBadges();
    return value;
  });
}

// --- inline badges ----------------------------------------------------------
// A single scoped stylesheet, no per-link DOM nodes: zero layout work on dynamic
// pages and nothing to clean up when links come and go. `pointer-events: none`
// keeps the link fully clickable.
let badgeStyle: HTMLStyleElement | null = null;

function badgeCss(): string {
  const onBigW = typeof location !== 'undefined' && /(^|\.)bigw\.com\.au$/.test(location.hostname ?? '');
  const selectors = [
    'a[href*="bigw.com.au/product/"][href*="/p/"]',
    ...(onBigW ? ['a[href^="/product/"][href*="/p/"]'] : []),
  ];
  // Badge only text links. Image/tile links usually sit next to a title link on
  // the same card; badging both would paint two "Duke" pills on every card. The
  // hover card still works on the image link (it is inferred from the anchor).
  const afterSelectors = selectors.map(selector => `${selector}:not(:has(*))::after`);
  return `${afterSelectors.join(',\n')} {
    content: "Duke";
    display: inline-block;
    margin-inline-start: 7px;
    padding: 2px 8px 2px 16px;
    border-radius: 999px;
    background-color: #fffefb;
    background-image: radial-gradient(circle at 8px 50%, #e8b429 0 2.6px, transparent 3px);
    border: 1px solid #e0dccd;
    color: #22261f;
    font: 680 9px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: .02em;
    vertical-align: middle;
    text-decoration: none;
    pointer-events: none;
    white-space: nowrap;
    box-shadow: 0 1px 3px rgba(34, 38, 31, .12);
  }`;
}

function badgesEnabled(): boolean {
  return !!settings && settings.hoverChip && settings.inlineBadges;
}

function syncBadges(): void {
  if (typeof document === 'undefined') return;
  if (!badgesEnabled()) {
    badgeStyle?.remove();
    badgeStyle = null;
    return;
  }
  if (badgeStyle?.isConnected) return;
  badgeStyle = document.createElement('style');
  badgeStyle.setAttribute(BADGE_ATTR, '');
  badgeStyle.textContent = badgeCss();
  (document.head ?? document.documentElement).appendChild(badgeStyle);
}

// --- run feedback -----------------------------------------------------------
// The chip stays up while a trigger is in flight and turns into either
// "Opening checkout…" or the exact error with a single remedial action.
type Phase = 'idle' | 'starting' | 'error';
let phase: Phase = 'idle';
let pinned = false;
let busy = false;

interface TriggerReply { ok?: boolean; code?: string; message?: string; fields?: Record<string, string> }

const SETUP_CODES = new Set(['PROFILE_REQUIRED', 'CARD_REQUIRED', 'VALIDATION', 'PROFILE_INCOMPLETE']);
const RETRY_CODES = new Set(['BRIDGE_UNREADY', 'BRIDGE_NO_RESPONSE', 'REQUEST_TIMEOUT', 'REQUEST_NETWORK', 'PAYMENT_NOT_READY', 'RUN_ACTIVE', 'TRIGGER_FAILED', 'UNEXPECTED']);

// --- chip DOM (shadow root; never leaks into / reads from the page) ---------

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let chipEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let actionsEl: HTMLElement | null = null;
let qtyEl: HTMLElement | null = null;
let checkoutEl: HTMLButtonElement | null = null;
let armEl: HTMLButtonElement | null = null;
let currentAnchor: Element | null = null;
let currentUrl = '';
let quantity = 1;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function anchorUrl(anchor: Element): string {
  const element = anchor as HTMLAnchorElement;
  return element.href || anchor.getAttribute('href') || '';
}

function anchorLabel(anchor: Element): string {
  const text = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 52 ? `${text.slice(0, 51)}…` : text;
}

function style(tag: keyof HTMLElementTagNameMap, css: string, className?: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  element.style.cssText = css;
  return element;
}

function ensureChip(): HTMLElement {
  if (chipEl) return chipEl;
  host = document.createElement('div');
  host.style.cssText = 'position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
  // mode: 'open' lets the integration test read the chip's button coordinates;
  // it is NOT the security boundary. The isTrusted guards below are: an open
  // shadow root still only accepts gestures the user made.
  shadow = host.attachShadow({ mode: 'open' });

  const sheet = document.createElement('style');
  sheet.textContent = `
    @keyframes duke-chip-in {
      from { opacity: 0; transform: translateY(6px) scale(.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .duke-chip {
      position: fixed; width: 322px; box-sizing: border-box;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      color: #22261f;
      background: #fffefb;
      border: 1px solid #e4e1d4; border-radius: 18px;
      padding: 13px 14px 14px;
      box-shadow: 0 0 0 1px rgba(34, 38, 31, .02), 0 2px 6px rgba(34, 38, 31, .05), 0 20px 48px rgba(34, 38, 31, .16);
      animation: duke-chip-in .18s cubic-bezier(.22, .7, .3, 1);
    }
    .duke-chip-head { display: flex; align-items: center; gap: 8px; }
    .duke-chip-mark {
      width: 26px; height: 27px; border-radius: 8px; flex: none;
      background: #22261f; color: #f8f6ee; display: grid; place-items: center;
      font: italic 23px/1 Georgia, serif; padding-bottom: 4px;
    }
    .duke-chip-brand { font-weight: 750; font-size: 12px; letter-spacing: -.01em; color: #22261f; }
    .duke-chip-retailer { font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #9aa08f; }
    .duke-chip-settings {
      margin-left: auto; flex: none; border: 0; background: transparent; color: #8d9382; cursor: pointer;
      font-size: 14px; line-height: 1; padding: 4px 6px; border-radius: 8px;
      transition: color .15s, background .15s;
    }
    .duke-chip-settings:hover { color: #22261f; background: #f1efe6; }
    .duke-chip-product {
      margin: 10px 0 0; color: #3d4438; font-size: 13px; font-weight: 580; line-height: 1.45;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .duke-chip-body { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .duke-qty {
      display: inline-flex; align-items: center; flex: none; height: 36px;
      border: 1px solid #dedbcd; border-radius: 999px; background: #faf8f2;
    }
    .duke-qty button {
      width: 32px; height: 34px; border: 0; background: transparent; color: #22261f;
      font: inherit; font-size: 16px; line-height: 1; cursor: pointer; border-radius: 999px;
      transition: background .15s;
    }
    .duke-qty button:disabled { opacity: .28; cursor: default; }
    .duke-qty button:hover:not(:disabled) { background: #ece9dd; }
    .duke-qty-value { min-width: 20px; text-align: center; font-weight: 720; font-variant-numeric: tabular-nums; color: #22261f; }
    .duke-chip-checkout {
      flex: 1; height: 36px; border: 0; border-radius: 10px; background: #f2c94c; color: #211d0e;
      font: inherit; font-size: 13px; font-weight: 720; letter-spacing: .005em;
      cursor: pointer; padding: 0 13px; white-space: nowrap;
      transition: background .15s, transform .15s;
    }
    .duke-chip-checkout:hover { background: #f6d472; }
    .duke-chip-checkout:active { transform: scale(.98); }
    .duke-chip-checkout:disabled, .duke-chip-arm:disabled { opacity: .5; cursor: default; }
    .duke-chip-arm {
      flex: none; height: 36px; border: 1px solid #dedbcd; border-radius: 10px;
      background: #fff; color: #3d4438; font: inherit; font-size: 12.5px; font-weight: 620;
      cursor: pointer; padding: 0 13px; transition: border-color .15s, background .15s;
    }
    .duke-chip-arm:hover { border-color: #b3b09d; background: #faf8f2; }
    .duke-chip-status { display: none; align-items: flex-start; gap: 7px; margin-top: 11px; font-size: 12px; line-height: 1.5; color: #6b7264; }
    .duke-chip-status.visible { display: flex; }
    .duke-chip-status::before {
      content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%;
      background: #c99a2e; margin-top: 6px;
    }
    .duke-chip-status.error { color: #97412f; }
    .duke-chip-status.error::before { background: #b3402f; }
    .duke-chip-status.success { color: #365731; }
    .duke-chip-status.success::before { background: #4f7f45; }
    .duke-chip-actions { display: none; gap: 7px; margin-top: 10px; flex-wrap: wrap; }
    .duke-chip-actions.visible { display: flex; }
    .duke-chip-actions button {
      border: 1px solid #dedbcd; border-radius: 999px; background: #fff; color: #3d4438;
      font: inherit; font-size: 12px; font-weight: 620; padding: 6px 12px; cursor: pointer;
      transition: border-color .15s, background .15s;
    }
    .duke-chip-actions button.primary { background: #22261f; color: #fbfaf4; border-color: #22261f; }
    .duke-chip-actions button:hover { border-color: #b3b09d; background: #faf8f2; }
    .duke-chip-actions button.primary:hover { background: #2e352a; border-color: #2e352a; }
    .duke-chip button:focus-visible { outline: 2px solid #2c674b; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .duke-chip { animation: none; } }
  `;
  shadow.appendChild(sheet);

  const chip = document.createElement('div');
  chip.className = 'duke-chip';
  chip.setAttribute('role', 'dialog');
  chip.setAttribute('aria-label', 'Duke checkout');

  const head = document.createElement('div');
  head.className = 'duke-chip-head';
  const mark = style('span', '', 'duke-chip-mark', 'd');
  const brand = style('span', '', 'duke-chip-brand', 'Duke');
  const retailer = style('span', '', 'duke-chip-retailer', 'BIG W');
  const gear = style('button', '', 'duke-chip-settings', '⚙') as HTMLButtonElement;
  gear.type = 'button';
  gear.title = 'Duke settings';
  gear.setAttribute('aria-label', 'Open Duke settings');
  gear.addEventListener('click', event => { if (event.isTrusted) openSettings(); });
  head.append(mark, brand, retailer, gear);
  const product = style('div', '', 'duke-chip-product', '');
  product.dataset.role = 'product';

  const body = document.createElement('div');
  body.className = 'duke-chip-body';
  const qty = document.createElement('div');
  qty.className = 'duke-qty';
  const minus = style('button', '', 'duke-qty-minus', '−') as HTMLButtonElement;
  minus.type = 'button';
  minus.setAttribute('aria-label', 'Decrease quantity');
  const value = style('span', '', 'duke-qty-value', '1');
  value.setAttribute('aria-live', 'polite');
  const plus = style('button', '', 'duke-qty-plus', '+') as HTMLButtonElement;
  plus.type = 'button';
  plus.setAttribute('aria-label', 'Increase quantity');
  minus.addEventListener('click', event => { if (event.isTrusted) changeQuantity(-1); });
  plus.addEventListener('click', event => { if (event.isTrusted) changeQuantity(1); });
  qty.append(minus, value, plus);

  const checkout = style('button', '', 'duke-chip-checkout', 'Checkout now') as HTMLButtonElement;
  checkout.type = 'button';
  // A page script can synthesize a click on this button, and with a remembered
  // session card that would be a purchase with no user gesture. Only gestures
  // the browser itself produced are honoured.
  checkout.addEventListener('click', event => { if (!event.isTrusted) return; void trigger('checkout'); });

  const arm = style('button', '', 'duke-chip-arm', 'Arm') as HTMLButtonElement;
  arm.type = 'button';
  arm.addEventListener('click', event => { if (!event.isTrusted) return; void trigger('arm'); });

  body.append(qty, checkout, arm);

  const status = style('div', '', 'duke-chip-status', '');
  status.setAttribute('role', 'status');
  const actions = style('div', '', 'duke-chip-actions', '');

  chip.append(head, product, body, status, actions);
  shadow.appendChild(chip);
  document.documentElement.appendChild(host);
  chipEl = chip;
  statusEl = status;
  actionsEl = actions;
  qtyEl = value;
  checkoutEl = checkout;
  armEl = arm;
  return chip;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

const FALLBACK_CHIP_WIDTH = 316;
const FALLBACK_CHIP_HEIGHT = 118;

function measuredChipWidth(chip: HTMLElement): number {
  const rect = chip.getBoundingClientRect?.();
  const measured = rect ? rect.width : 0;
  return measured > 0 ? measured : FALLBACK_CHIP_WIDTH;
}

function measuredChipHeight(chip: HTMLElement): number {
  const rect = chip.getBoundingClientRect?.();
  const measured = rect ? rect.height : 0;
  return measured > 0 ? measured : FALLBACK_CHIP_HEIGHT;
}

function positionChip(chip: HTMLElement, anchor: Element): void {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth || 0;
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight || 0;
  const chipWidth = measuredChipWidth(chip);
  const chipHeight = measuredChipHeight(chip);
  const left = clamp(rect.left, 4, Math.max(4, viewportWidth - chipWidth));
  // Prefer below the link; flip above when there is no room underneath.
  const below = rect.bottom + 8;
  const top = below + chipHeight <= viewportHeight - 4
    ? below
    : clamp(rect.top - chipHeight - 8, 4, Math.max(4, viewportHeight - chipHeight - 4));
  chip.style.left = `${left}px`;
  chip.style.top = `${top}px`;
}

// --- quantity ---------------------------------------------------------------

function changeQuantity(delta: number): void {
  quantity = clamp(quantity + delta, 1, 20);
  if (qtyEl) qtyEl.textContent = String(quantity);
  const minus = shadow?.querySelector<HTMLButtonElement>('.duke-qty-minus');
  const plus = shadow?.querySelector<HTMLButtonElement>('.duke-qty-plus');
  if (minus) minus.disabled = quantity <= 1;
  if (plus) plus.disabled = quantity >= 20;
}

function setQuantity(value: number): void {
  quantity = clamp(Math.round(value) || 1, 1, 20);
  if (qtyEl) qtyEl.textContent = String(quantity);
}

// --- status + actions -------------------------------------------------------

function setStatus(message: string, tone: 'info' | 'error' | 'success' = 'info'): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = `duke-chip-status visible${tone === 'info' ? '' : ` ${tone}`}`;
}

function clearStatus(): void {
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'duke-chip-status'; }
}

function clearActions(): void {
  if (actionsEl) { actionsEl.replaceChildren(); actionsEl.className = 'duke-chip-actions'; }
}

function addAction(label: string, primary: boolean, onClick: () => void): void {
  if (!actionsEl) return;
  const button = document.createElement('button');
  button.type = 'button';
  if (primary) button.className = 'primary';
  button.textContent = label;
  // Same gesture boundary as the checkout buttons: a page script can reach the
  // open shadow root, so only a browser-generated click may act.
  button.addEventListener('click', event => { if (event.isTrusted) onClick(); });
  actionsEl.appendChild(button);
  actionsEl.className = 'duke-chip-actions visible';
}

function setBusy(value: boolean): void {
  busy = value;
  if (checkoutEl) checkoutEl.disabled = value;
  if (armEl) armEl.disabled = value;
  const minus = shadow?.querySelector<HTMLButtonElement>('.duke-qty-minus');
  const plus = shadow?.querySelector<HTMLButtonElement>('.duke-qty-plus');
  if (minus) minus.disabled = value || quantity <= 1;
  if (plus) plus.disabled = value || quantity >= 20;
}

function resetState(): void {
  phase = 'idle';
  pinned = false;
  busy = false;
  clearStatus();
  clearActions();
  if (checkoutEl) checkoutEl.textContent = 'Checkout now';
  setBusy(false);
}

function showError(code: string, message: string): void {
  phase = 'error';
  pinned = true;
  setBusy(false);
  setStatus(message, 'error');
  clearActions();
  if (SETUP_CODES.has(code)) {
    addAction('Open Duke setup', true, openSettings);
  } else if (RETRY_CODES.has(code)) {
    addAction('Retry', true, () => { resetState(); void trigger('checkout'); });
    addAction('Open Duke', false, openSettings);
  } else {
    addAction('Open Duke', true, openSettings);
  }
  addAction('Dismiss', false, () => { resetState(); hideChip(); });
}

// --- lifecycle --------------------------------------------------------------

export function showChip(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  const anchor = currentAnchor;
  if (!anchor) return;
  void ensureSettings().then(current => {
    if (!current.hoverChip) { hideChip(); return; }
    if (currentAnchor !== anchor) return;
    const chip = ensureChip();
    const product = shadow?.querySelector<HTMLElement>('[data-role="product"]');
    if (product) product.textContent = anchorLabel(anchor);
    if (phase === 'idle') setQuantity(current.quantity);
    positionChip(chip, anchor);
  });
}

export function hideChip(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  currentAnchor = null;
  currentUrl = '';
  if (host && host.parentNode) host.parentNode.removeChild(host);
  host = null;
  shadow = null;
  chipEl = null;
  statusEl = null;
  actionsEl = null;
  qtyEl = null;
  checkoutEl = null;
  armEl = null;
  resetState();
}

export function chipVisible(): boolean {
  return !!chipEl && !!host && !!host.parentNode;
}

function scheduleHide(): void {
  if (pinned) return;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { hideTimer = null; hideChip(); }, HIDE_GRACE_MS);
}

function inChip(node: Node | null | undefined): boolean {
  if (!node) return false;
  if (host && (node === host || host.contains(node))) return true;
  const element = node as Element;
  const root = typeof element.getRootNode === 'function' ? element.getRootNode() : null;
  return !!shadow && root === shadow;
}

// A hostile page can dispatch `mouseover` on a product anchor to force the chip
// to appear under the user's cursor. Only the browser's own trusted pointer
// events are accepted; synthetic events are ignored entirely.
export function handleMouseOver(event: Event): void {
  if (!event.isTrusted) return;
  applyHover(event.target as Element | null);
}

// The anchoring core, split out from the guarded handler so tests can drive it
// without a trusted event (jsdom cannot produce one). Never reachable from the
// page: only handleMouseOver and the exported test surface call it.
function applyHover(target: Element | null): void {
  if (inChip(target)) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    return;
  }
  const anchor = target?.closest?.('a[href]') ?? null;
  const url = anchor ? anchorUrl(anchor) : '';
  if (!anchor || !isProductUrl(url)) { scheduleHide(); return; }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  currentAnchor = anchor;
  currentUrl = url;
  reportHover(url);
  if (showTimer) clearTimeout(showTimer);
  showTimer = setTimeout(() => { showTimer = null; showChip(); }, SHOW_DELAY_MS);
}

function handleMouseOut(event: Event): void {
  if (!currentAnchor || pinned) return;
  const related = (event as MouseEvent)?.relatedTarget as Node | null;
  if (inChip(related)) return;
  if (related && (related === currentAnchor || currentAnchor.contains(related))) return;
  scheduleHide();
}

// --- triggers ---------------------------------------------------------------

function sendTrigger(type: string, url: string, extra: Record<string, unknown> = {}): Promise<TriggerReply | undefined> {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return Promise.resolve(undefined);
    return Promise.resolve(chrome.runtime.sendMessage({ type, url, ...extra }) as Promise<TriggerReply>).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

async function trigger(type: 'checkout' | 'arm'): Promise<void> {
  const url = currentUrl;
  if (!url || busy) return;
  phase = 'starting';
  setBusy(true);
  clearActions();
  setStatus(type === 'checkout' ? `Preparing ${quantity} × checkout…` : 'Arming this product…');

  if (type === 'arm') {
    const reply = await sendTrigger('trigger.arm', url);
    if (reply?.ok) {
      setStatus('Armed. Hover again to check out.', 'success');
      setTimeout(hideChip, 1_800);
    } else {
      showError(reply?.code ?? 'TRIGGER_FAILED', reply?.message ?? 'Could not arm this product right now.');
    }
    return;
  }

  const reply = await sendTrigger('trigger.checkout', url, { quantity });
  if (reply?.ok) {
    // The progress tab is already open (the worker creates it before starting
    // the run), so the chip can step aside without losing the user.
    setStatus('Opening your checkout…', 'success');
    setTimeout(() => { if (phase === 'starting') hideChip(); }, 900);
    return;
  }
  showError(reply?.code ?? 'TRIGGER_FAILED', reply?.message ?? 'The checkout could not start.');
}

function openSettings(): void {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
    void chrome.runtime.sendMessage({ id: messageId(), type: 'ui.open', payload: null }).catch(() => undefined);
  } catch { /* extension unavailable */ }
}

// Report the link under the pointer so the service worker's keyboard command
// can target it. Throttled to at most one report per URL per 500 ms so a fast
// pointer sweep does not flood the channel.
let lastHoverUrl = '';
let lastHoverAt = 0;
const HOVER_REPORT_THROTTLE_MS = 500;

function reportHover(url: string): void {
  const now = Date.now();
  if (url === lastHoverUrl && now - lastHoverAt < HOVER_REPORT_THROTTLE_MS) return;
  lastHoverUrl = url;
  lastHoverAt = now;
  void sendTrigger('trigger.hovered', url);
}

// --- wiring -----------------------------------------------------------------

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') hideChip();
}

function onScroll(): void { hideChip(); }

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('mouseover', handleMouseOver, true);
  document.addEventListener('mouseout', handleMouseOut, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('keydown', onKeyDown, true);
  // Settings (and with them the inline badges) are loaded as soon as possible,
  // not only on the first hover, so badges appear on page load.
  void ensureSettings();
}

function reset(): void {
  hideChip();
  settings = null;
  storageListenerAttached = false;
  lastHoverUrl = '';
  lastHoverAt = 0;
  badgeStyle?.remove();
  badgeStyle = null;
}

export const __test = {
  handleMouseOver,
  applyHover,
  showChip,
  hideChip,
  chipVisible,
  isProductUrl,
  // Simulates a genuine chip activation. The production path requires a trusted
  // click (covered by the Stage-3 puppeteer integration test); jsdom cannot
  // forge isTrusted, so the send logic is exercised directly here.
  activate(type: 'checkout' | 'arm', url: string): void {
    currentUrl = url;
    void trigger(type);
  },
  setSettings(value: Partial<ScoutSettings>): void {
    settings = {
      hoverChip: value?.hoverChip !== false,
      inlineBadges: value?.inlineBadges !== false,
      quantity: value?.quantity === undefined ? 1 : clamp(Math.round(value.quantity) || 1, 1, 20),
    };
    syncBadges();
  },
  setQuantity,
  getQuantity: () => quantity,
  getPhase: () => phase,
  badgePresent: () => !!badgeStyle?.isConnected,
  reset,
  getShadowRoot: () => shadow,
  getHost: () => host,
};
