// ---------------------------------------------------------------------------
// link-scout — the hover chip (Stage 3, Task 1)
// ---------------------------------------------------------------------------
// A trigger-agnostic entry point. It watches for pointer hover over BIG W
// product links on ANY site and offers a small floating chip with two actions:
// "Checkout now" and "Arm". It never performs checkout work itself; it only
// emits intent for the service worker's trigger handlers.
//
// MESSAGE-NAMESPACE OWNERSHIP (who is allowed to answer what)
//   bridge.*  → the ISOLATED relay (api-bridge-isolated) is the ONLY responder.
//   driver.*  → the checkout driver (checkout-driver) is the ONLY responder.
//   trigger.* → service-worker trigger handlers consume these (senders only).
//   This file NEVER calls chrome.runtime.onMessage.addListener — it only SENDS
//   trigger.* messages, so it cannot race any other content script for a
//   response channel. The Main-world bridge and guard are out of scope here.
//
// Constraints: no page DOM is mutated outside our own shadow host; the host is
// attached to document.documentElement so page CSS cannot reach the chip, and
// the chip wrapper resets all inherited styling with `all: initial`. Anchor
// clicks are never intercepted (no preventDefault), so normal navigation is
// untouched.
// ---------------------------------------------------------------------------

// The product-link predicate lives in lib/ so the service worker can import it
// without pulling in this content script; re-exported here to keep the chip's
// existing surface (and the __test export below) intact.
import { isProductUrl } from '../lib/product-url.ts';
export { isProductUrl } from '../lib/product-url.ts';

interface ScoutSettings { hoverChip: boolean }
const DEFAULT_SETTINGS: ScoutSettings = { hoverChip: true };
const SHOW_DELAY_MS = 200;
const HIDE_GRACE_MS = 120;

// Settings are read lazily on first need and cached; chrome.storage.onChanged
// keeps the cache fresh. When storage is unavailable or unreadable the default
// (hoverChip: true) is used so the chip is never silently disabled by a broken
// environment.
let settings: ScoutSettings | null = null;
let storageListenerAttached = false;

function loadSettings(): Promise<ScoutSettings> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) return Promise.resolve(DEFAULT_SETTINGS);
    return Promise.resolve(chrome.storage.local.get(['dukeSettings']))
      .then(items => {
        const raw = (items as Record<string, unknown> | undefined)?.dukeSettings as { hoverChip?: unknown } | undefined;
        return { hoverChip: typeof raw?.hoverChip === 'boolean' ? raw.hoverChip : true };
      })
      .catch(() => DEFAULT_SETTINGS);
  } catch {
    return Promise.resolve(DEFAULT_SETTINGS);
  }
}

function attachStorageListener(): void {
  if (storageListenerAttached) return;
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged?.addListener) return;
  storageListenerAttached = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area && area !== 'local') return;
    const change = (changes as Record<string, { newValue?: { hoverChip?: unknown } }>).dukeSettings;
    if (!change) return;
    const next = change.newValue;
    settings = { hoverChip: typeof next?.hoverChip === 'boolean' ? next.hoverChip : true };
  });
}

function ensureSettings(): Promise<ScoutSettings> {
  if (settings) return Promise.resolve(settings);
  return loadSettings().then(value => {
    settings ??= value;
    attachStorageListener();
    return value;
  });
}

// --- chip DOM (shadow root; never leaks into / reads from the page) ---------

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let chipEl: HTMLElement | null = null;
let currentAnchor: Element | null = null;
let currentUrl = '';
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function anchorUrl(anchor: Element): string {
  const element = anchor as HTMLAnchorElement;
  return element.href || anchor.getAttribute('href') || '';
}

function ensureChip(): HTMLElement {
  if (chipEl) return chipEl;
  host = document.createElement('div');
  host.style.cssText = 'position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
  // mode: 'open' lets the Stage-3 integration test read the chip's button
  // coordinates; it is NOT the security boundary. The isTrusted guards below
  // are: an open shadow root still only accepts gestures the user made.
  shadow = host.attachShadow({ mode: 'open' });

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'all: initial;';

  const chip = document.createElement('div');
  chip.className = 'duke-chip';
  chip.style.cssText = 'position: fixed; font: 13px/1.4 system-ui, sans-serif; color: #fff;'
    + ' background: #111; border-radius: 999px; padding: 6px 10px; display: flex; align-items: center;'
    + ' gap: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.35); white-space: nowrap;';

  const label = document.createElement('span');
  label.textContent = 'Duke ▸ checkout';
  label.style.cssText = 'opacity: .85;';

  const checkout = document.createElement('button');
  checkout.type = 'button';
  checkout.className = 'duke-chip-checkout';
  checkout.textContent = 'Checkout now';
  checkout.style.cssText = 'cursor: pointer; border: 0; border-radius: 999px; padding: 4px 10px;'
    + ' background: #f5c518; color: #111; font: inherit; font-weight: 600;';
  // A page script can synthesize a click on this button, and with a remembered
  // session card that would be a purchase with no user gesture. Only gestures
  // the browser itself produced are honoured.
  checkout.addEventListener('click', event => { if (!event.isTrusted) return; trigger('trigger.checkout'); });

  const arm = document.createElement('button');
  arm.type = 'button';
  arm.className = 'duke-chip-arm';
  arm.textContent = 'Arm';
  arm.style.cssText = 'cursor: pointer; border: 1px solid #fff; border-radius: 999px; padding: 4px 10px;'
    + ' background: transparent; color: #fff; font: inherit;';
  arm.addEventListener('click', event => { if (!event.isTrusted) return; trigger('trigger.arm'); });

  chip.append(label, checkout, arm);
  wrapper.appendChild(chip);
  shadow.appendChild(wrapper);
  document.documentElement.appendChild(host);
  chipEl = chip;
  return chip;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

const FALLBACK_CHIP_WIDTH = 220;

function measuredChipWidth(chip: HTMLElement): number {
  const rect = chip.getBoundingClientRect?.();
  const measured = rect ? rect.width : 0;
  return measured > 0 ? measured : FALLBACK_CHIP_WIDTH;
}

function positionChip(chip: HTMLElement, anchor: Element): void {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth || 0;
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight || 0;
  const chipWidth = measuredChipWidth(chip);
  const left = clamp(rect.left, 4, Math.max(4, viewportWidth - chipWidth));
  const top = clamp(rect.bottom + 8, 4, Math.max(4, viewportHeight - 44));
  chip.style.left = `${left}px`;
  chip.style.top = `${top}px`;
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
}

export function chipVisible(): boolean {
  return !!chipEl && !!host && !!host.parentNode;
}

function scheduleHide(): void {
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
  if (!currentAnchor) return;
  const related = (event as MouseEvent)?.relatedTarget as Node | null;
  if (inChip(related)) return;
  if (related && (related === currentAnchor || currentAnchor.contains(related))) return;
  scheduleHide();
}

// --- triggers ---------------------------------------------------------------

function sendTrigger(type: string, url: string): void {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
    void chrome.runtime.sendMessage({ type, url })?.catch?.(() => undefined);
  } catch { /* service worker unavailable */ }
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
  sendTrigger('trigger.hovered', url);
}

function trigger(type: 'trigger.checkout' | 'trigger.arm'): void {
  const url = currentUrl;
  if (url) sendTrigger(type, url);
  hideChip();
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
}

function reset(): void {
  hideChip();
  settings = null;
  lastHoverUrl = '';
  lastHoverAt = 0;
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
    trigger(type === 'checkout' ? 'trigger.checkout' : 'trigger.arm');
  },
  setSettings(value: Partial<ScoutSettings>): void {
    settings = { hoverChip: value?.hoverChip !== false };
  },
  reset,
  getShadowRoot: () => shadow,
  getHost: () => host,
};
