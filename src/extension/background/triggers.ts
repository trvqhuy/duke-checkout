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
import { isProductUrl } from '../lib/product-url.ts';
import { isEvent } from '../lib/protocol.ts';
import { configureAppPage, ensureAppPage, openAppPage } from './app-page.ts';
import { getArmed } from './state.ts';
import { setBadge } from './badge.ts';
import { NOTIFICATION_ICON } from './notify.ts';
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

// A hard floor on how often auto-arm may fire across ALL tabs: a burst of
// product-page navigations (opening several tabs, a redirect chain) collapses
// to one arm instead of one retailer API call per tab.
export const AUTO_ARM_MIN_INTERVAL_MS = 5_000;
let lastAutoArmAt = 0;

// Claims the single global auto-arm slot. Returns false, leaving the slot
// untouched, when the previous arm was less than AUTO_ARM_MIN_INTERVAL_MS ago.
// `now` is injectable so tests can drive it deterministically.
export function claimAutoArmSlot(now: number = Date.now()): boolean {
  if (now - lastAutoArmAt < AUTO_ARM_MIN_INTERVAL_MS) return false;
  lastAutoArmAt = now;
  return true;
}

export function resetAutoArmSlots(): void { lastAutoArmAt = 0; }

// --- injected collaborators -------------------------------------------------
// The service worker owns the adapter (with its armed store) and the run
// manager singleton, so it injects them here rather than this module building
// its own copies. Keeping the dependencies behind a small interface lets tests
// import the pure helpers without a chrome runtime.
export interface TriggerArm { arm(input: RunRequest, report: StageReporter, signal: AbortSignal): Promise<ArmedCheckout> }
export interface TriggerRun { start(payload: unknown): Promise<unknown>; activeRunId?: string | null }
export interface TriggerDeps { adapter: TriggerArm; manager: TriggerRun }

let deps: TriggerDeps | null = null;
export function configureTriggers(next: TriggerDeps): void {
  deps = next;
  // openAppPage must not reload an existing app tab mid-run, so it asks the same
  // manager the triggers use whether a run is active.
  configureAppPage({ activeRunId: () => next.manager.activeRunId ?? null });
}
function requireDeps(): TriggerDeps {
  if (!deps) throw new Error('Trigger handlers are not configured.');
  return deps;
}

function broadcast(event: { type: string; payload: unknown }): void {
  if (!isEvent(event)) return;
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

// The icon lives in notify.ts so the hint and the outcome notifications share
// one mark (a one-way import). openAppPage now lives in app-page.ts, so there
// is no triggers <-> notify module cycle.
function notifyHint(message: string): void {
  try {
    void chrome.notifications.create({
      type: 'basic', iconUrl: NOTIFICATION_ICON, title: 'Duke Checkout', message,
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
  // One badge writer for every arm path (chip, menu, shortcut, auto-arm, RPC):
  // arming means "armed". Disarming stays with arm.clear's own setBadge('idle').
  setBadge('armed');
  broadcast({ type: 'arm.update', payload: armed });
  return armed;
}

// --- dispatch ---------------------------------------------------------------
export async function dispatchTrigger(action: TriggerAction, url: string, _tabId?: number): Promise<void> {
  if (!isProductUrl(url)) { notifyHint('Open a BIG W product link first.'); return; }
  const { manager } = requireDeps();
  const [settings, profile, card] = await Promise.all([getSettings(), getProfile(), getSessionCard()]);
  const hasCard = !!card;
  const plan = triggerPlan({ settings, hasProfile: !!profile, hasCard }, action);

  if (plan === 'open-onboarding') { await openAppPage({ onboarding: '1', product: url }); return; }
  if (plan === 'open-app') {
    // triggerPlan returns 'open-app' for two reasons: confirm-before-pay wants
    // the user to review, or a card-mode has no card. Only the missing-card case
    // needs the setup panel, so the user can enter a card; a review keeps the
    // plain product hand-off.
    if (!settings.confirmBeforePay && modeNeedsCard(settings.mode) && !card) {
      await openAppPage({ onboarding: '1', product: url }); return;
    }
    await openAppPage({ product: url }); return;
  }
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
      // Never auto-arm while a run is in flight: the work tab and the armed
      // store belong to that run, and arming would fight it.
      if (deps?.manager.activeRunId) return;
      const settings = await getSettings();
      if (!settings.autoArm) return;
      const armed = await getArmed().catch(() => null);
      if (!shouldAutoArm(settings, armed, url)) return;
      // One arm per AUTO_ARM_MIN_INTERVAL_MS across every tab bounds retailer
      // API calls even when many product pages open at once.
      if (!claimAutoArmSlot()) return;
      scheduleAutoArm(tabId, () => {
        void armProduct(url).catch(error => console.warn('[duke] auto-arm failed', error));
      });
    })().catch(() => undefined);
  });
  // Closing a tab drops its hovered link; never arm a tab that is gone.
  chrome.tabs.onRemoved.addListener(tabId => { clearLastHovered(tabId); });
}
