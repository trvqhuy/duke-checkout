// ---------------------------------------------------------------------------
// triggers — the service-worker command surface (Stage 3, Tasks 2+3)
// ---------------------------------------------------------------------------
// One place decides what "checkout this link" and "arm this product" mean,
// whether they arrive from the context menu, a keyboard command, the hover
// chip, or auto-arm on page load. The decision is a pure function
// (triggerPlan) so the policy and the dispatch can never drift, and the
// dispatch reuses the exact hasProfile/hasCard inputs it computed for the plan.
//
// Pure helpers are exported for tests; every chrome.* access happens inside a
// register/step function so importing this module is side-effect free.
// ---------------------------------------------------------------------------
import { getSettings, getProfile, getSessionCard, type DukeSettings } from '../lib/storage.ts';
import { isProductUrl } from '../content/link-scout.ts';
import { isEvent } from '../lib/protocol.ts';
import { getArmed } from './state.ts';
import type { ArmedCheckout, RunRequest, StageReporter } from '../../shared/types.ts';

export type TriggerAction = 'checkout' | 'arm';
export type TriggerPlan = 'arm' | 'start' | 'open-app' | 'open-onboarding';

// Modes that pause for the user in the app (fill-only or a real payment) need a
// card before a run can start; prepare and afterpay do not.
function modeNeedsCard(mode: DukeSettings['mode']): boolean {
  return mode === 'assist' || mode === 'purchase';
}

// The single source of truth for a trigger. Order matters:
//   no profile            -> send them to onboarding first
//   explicit arm          -> arm (onboarding still wins if there is no profile)
//   confirm-before-pay    -> hand control to the app
//   a card is required    -> hand control to the app to collect one
//   otherwise             -> start the run in the background
export function triggerPlan(
  state: { settings: DukeSettings; hasProfile: boolean; hasCard: boolean },
  action: TriggerAction,
): TriggerPlan {
  if (!state.hasProfile) return 'open-onboarding';
  if (action === 'arm') return 'arm';
  if (state.settings.confirmBeforePay) return 'open-app';
  if (modeNeedsCard(state.settings.mode) && !state.hasCard) return 'open-app';
  return 'start';
}

// Auto-arm only fires for a real product page, when the feature is on, and when
// that exact product is not already the armed checkout.
export function shouldAutoArm(
  settings: Pick<DukeSettings, 'autoArm'>,
  armed: ArmedCheckout | null,
  url: string,
): boolean {
  return settings.autoArm && isProductUrl(url) && (!armed || armed.productUrl !== url);
}

// --- last-hovered store -----------------------------------------------------
// The hover chip reports the product URL under the pointer per tab; the
// keyboard command uses it so "checkout" can target a link that is not the
// page's own URL.
const lastHovered = new Map<number, string>();

export function setLastHovered(tabId: number, url: string): void { lastHovered.set(tabId, url); }
export function getLastHovered(tabId: number): string | undefined { return lastHovered.get(tabId); }
export function clearLastHovered(tabId: number): void { lastHovered.delete(tabId); }

// --- auto-arm debounce ------------------------------------------------------
// One pending timer per tab: a burst of onUpdated events for the same tab
// collapses into a single arm. setTimeout-based so fake timers can drive it.
export const AUTO_ARM_DEBOUNCE_MS = 1_000;
const autoArmTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function scheduleAutoArm(tabId: number, run: () => void, delay = AUTO_ARM_DEBOUNCE_MS): void {
  const existing = autoArmTimers.get(tabId);
  if (existing !== undefined) clearTimeout(existing);
  autoArmTimers.set(tabId, setTimeout(() => { autoArmTimers.delete(tabId); run(); }, delay));
}

// --- injected collaborators -------------------------------------------------
// The service worker owns the adapter (with its armed store) and the run
// manager singleton, so it injects them here rather than this module building
// its own copies. Keeping the dependencies behind a small interface lets tests
// import the pure helpers without a chrome runtime.
export interface TriggerArm { arm(input: RunRequest, report: StageReporter, signal: AbortSignal): Promise<ArmedCheckout> }
export interface TriggerRun { start(payload: unknown): Promise<unknown> }
export interface TriggerDeps { adapter: TriggerArm; manager: TriggerRun }

let deps: TriggerDeps | null = null;
export function configureTriggers(next: TriggerDeps): void { deps = next; }
function requireDeps(): TriggerDeps {
  if (!deps) throw new Error('Trigger handlers are not configured.');
  return deps;
}

function broadcast(event: { type: string; payload: unknown }): void {
  if (!isEvent(event)) return;
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

// TODO(notifications task): unify with notify.ts once that module lands.
// A 1x1 transparent PNG keeps the basic notification valid without shipping an
// icon asset.
const HINT_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function notifyHint(message: string): void {
  try {
    void chrome.notifications.create({
      type: 'basic', iconUrl: HINT_ICON, title: 'Duke Checkout', message,
    }).catch(() => undefined);
  } catch { /* notifications unavailable */ }
}

// --- arm --------------------------------------------------------------------
// Builds the RunRequest from stored settings + profile (or takes a caller-built
// one), arms through the injected adapter (which publishes into the armed store
// and session storage), and broadcasts the result. The service worker's
// arm.start handler calls this so both paths stay identical.
export async function armProduct(url: string, provided?: RunRequest): Promise<ArmedCheckout | null> {
  const { adapter } = requireDeps();
  let input = provided;
  if (!input) {
    const [settings, profile] = await Promise.all([getSettings(), getProfile()]);
    if (!profile) return null;
    input = {
      productUrl: url,
      quantity: settings.quantity,
      maxTotalCents: Math.round(Number(settings.maxTotalAUD) * 100),
      mode: settings.mode,
      profile,
    };
  }
  const armed = await adapter.arm(input, () => undefined, new AbortController().signal);
  broadcast({ type: 'arm.update', payload: armed });
  return armed;
}

// --- app page routing -------------------------------------------------------
export function appUrlFor(query: Record<string, string> = {}): string {
  const base = chrome.runtime.getURL('app.html');
  const search = new URLSearchParams(query).toString();
  return search ? `${base}?${search}` : base;
}

async function findAppTabId(): Promise<number | null> {
  const base = chrome.runtime.getURL('app.html');
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const match = contexts.find(context => (context.documentUrl ?? '').startsWith(base));
    if (match && typeof match.tabId === 'number' && match.tabId !== chrome.tabs.TAB_ID_NONE) return match.tabId;
  } catch { /* getContexts is Chrome 116+; fall through to the tab query */ }
  try {
    const tabs = await chrome.tabs.query({ url: `${base}*` });
    return tabs[0]?.id ?? null;
  } catch { return null; }
}

// Focus an existing app page (idempotently re-pointing it at the requested
// query) or open a new one. Query params carry product/onboarding intent.
export async function openAppPage(query: Record<string, string> = {}): Promise<void> {
  const url = appUrlFor(query);
  const tabId = await findAppTabId();
  if (tabId !== null) { await chrome.tabs.update(tabId, { url, active: true }).catch(() => undefined); return; }
  await chrome.tabs.create({ url, active: true }).catch(() => undefined);
}

// A run needs an app page open so its `duke-run` port keeps the worker alive.
async function ensureAppPage(): Promise<void> {
  if (await findAppTabId() !== null) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL('app.html'), active: false }).catch(() => undefined);
}

// --- dispatch ---------------------------------------------------------------
export async function dispatchTrigger(action: TriggerAction, url: string, _tabId?: number): Promise<void> {
  if (!isProductUrl(url)) { notifyHint('Open a BIG W product link first.'); return; }
  const { manager } = requireDeps();
  const [settings, profile, card] = await Promise.all([getSettings(), getProfile(), getSessionCard()]);
  const hasCard = !!card;
  const plan = triggerPlan({ settings, hasProfile: !!profile, hasCard }, action);

  if (plan === 'open-onboarding') { await openAppPage({ onboarding: '1', product: url }); return; }
  if (plan === 'open-app') { await openAppPage({ product: url }); return; }
  if (plan === 'arm') {
    try { await armProduct(url); }
    catch (error) { console.warn('[duke] arm trigger failed', error); notifyHint(error instanceof Error ? error.message : 'Could not arm this product right now.'); }
    return;
  }

  // plan === 'start'. triggerPlan already returned 'open-app' when a required
  // card is missing, so this guard only matters if the inputs changed under us.
  const needsCard = modeNeedsCard(settings.mode);
  if (needsCard && !card) { await openAppPage({ product: url }); return; }
  await ensureAppPage();
  await manager.start({
    requestId: crypto.randomUUID(),
    productUrl: url,
    quantity: settings.quantity,
    // validateRun (the RunManager's gate) takes `maxTotal` in dollars; it
    // converts to cents itself.
    maxTotal: settings.maxTotalAUD,
    mode: settings.mode,
    profile,
    card: needsCard && card ? { kind: 'new', number: card.number, expiry: card.expiry, cvv: card.cvv } : undefined,
  });
}

// --- registration -----------------------------------------------------------
export function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'duke-checkout', title: 'Duke: one-click checkout this link', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'duke-arm', title: 'Duke: arm this product', contexts: ['link'] });
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const action: TriggerAction = info.menuItemId === 'duke-arm' ? 'arm' : 'checkout';
    void dispatchTrigger(action, info.linkUrl ?? '', tab?.id).catch(() => undefined);
  });
}

export const CHECKOUT_COMMAND = 'duke-checkout';

export function registerCommands(): void {
  chrome.commands.onCommand.addListener(command => {
    if (command !== CHECKOUT_COMMAND) return;
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const hovered = getLastHovered(tab.id);
      const candidate = hovered && isProductUrl(hovered) ? hovered : isProductUrl(tab.url ?? '') ? tab.url! : '';
      await dispatchTrigger('checkout', candidate, tab.id);
    })().catch(() => undefined);
  });
}

export function registerAutoArm(): void {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // A navigation invalidates the hovered link for that tab.
    if (changeInfo.url) clearLastHovered(tabId);
    if (changeInfo.status !== 'complete' || !tab.url || !isProductUrl(tab.url)) return;
    const url = tab.url;
    void (async () => {
      const settings = await getSettings();
      if (!settings.autoArm) return;
      const armed = await getArmed().catch(() => null);
      if (!shouldAutoArm(settings, armed, url)) return;
      scheduleAutoArm(tabId, () => {
        void armProduct(url).catch(error => console.warn('[duke] auto-arm failed', error));
      });
    })().catch(() => undefined);
  });
  // Closing a tab drops its hovered link; never arm a tab that is gone.
  chrome.tabs.onRemoved.addListener(tabId => { clearLastHovered(tabId); });
}
