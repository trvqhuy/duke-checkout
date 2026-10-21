import { decodeRequest, encodeResponse, isEvent, type DukeRequest } from '../lib/protocol.ts';
import { getSettings, putSettings, getProfile, putProfile, getHistory, getSessionCard, putSessionCard, clearSessionCard, getCard, saveCard, forgetCard, cardStatus, DEFAULT_SETTINGS, type DukeSettings, type SessionCard } from '../lib/storage.ts';
import { clearDeviceCard } from '../lib/card-vault.ts';
import { acquireWorkTab, ensureBridge, waitForBridgeReady } from './work-tab.ts';
import { getArmed, setArmed, clearArmed } from './state.ts';
import { registerKeeper } from './keeper.ts';
import { BigWExtensionAdapter } from '../lib/retailers/bigw/adapter.ts';
import { RunManager } from './run-manager.ts';
import { driverHandleFor } from './driver.ts';
import { setBadge, badgeStateForRun } from './badge.ts';
import { configureTriggers, registerContextMenus, registerCommands, registerAutoArm, dispatchTriggerSafely, armProduct, setLastHovered } from './triggers.ts';
import { openAppPage, appPageIsOpen } from './app-page.ts';
import { registerNotifications } from './notify.ts';
import { AppError, publicError } from '../../server/errors.ts';
import type { GuardEventRecord } from '../lib/retailers/types.ts';
import type { ArmedCheckout, CheckoutRun, RunRequest } from '../../shared/types.ts';
import { validateProfile } from '../../shared/validation.ts';

// The armed checkout, mirrored from chrome.storage.session into memory so the
// adapter's synchronous armedState() can answer the RunManager's fast-path
// check without async storage. The store's set() is the single writer: it keeps
// the cache and session storage in lockstep.
let armedCache: ArmedCheckout | null = null;

// MAIN-world guard events, forwarded per tab by the isolated relay and bounded
// like the observer's ring buffer. They are ADVISORY (any page script can forge
// them), so nothing acts on them except the adapter's blocked-vs-unknown
// reconciliation: a `prevented` event with no `sent` event means the guard
// blocked a submission before it reached the network. Keyed by tab so a stale
// event from another checkout cannot settle a run.
interface TabGuardEvent { tabId: number; type: string; code?: string; at: number }
const GUARD_EVENT_LIMIT = 20;
const guardEventLog: TabGuardEvent[] = [];
export function guardEventsFor(tabId: number): GuardEventRecord[] {
  return guardEventLog.filter(event => event.tabId === tabId).map(event => ({ type: event.type, code: event.code, at: event.at }));
}

// Every acquire returns the tab id, the bridge sender, and a fresh Stage-2
// driver handle for that tab (the driver is chrome-backed, so it is built here
// where chrome exists, keeping the adapter headless).
const adapter = new BigWExtensionAdapter(
  async pinnedTabId => {
    // After revealPrepared the run pins its own checkout tab. Re-querying "a
    // BIG W tab" at that point could pick a stale checkout from an earlier run
    // (multiple tabs are normal), so the pin wins whenever it still exists.
    const pinned = typeof pinnedTabId === 'number' ? await chrome.tabs.get(pinnedTabId).catch(() => null) : null;
    const tab = pinned?.id !== undefined ? pinned : await acquireWorkTab();
    if (typeof tab.id !== 'number') throw new AppError('BRIDGE_UNREADY', 'No BIG W tab is available. Open bigw.com.au once.');
    await ensureBridge(tab.id);
    return { tabId: tab.id, sender: { sendMessage: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg as never) }, driver: driverHandleFor(tab.id, undefined, guardEventsFor) };
  },
  {
    get: () => armedCache,
    set: value => { armedCache = value; void (value ? setArmed(value) : clearArmed()); },
  },
);

// Terminal statuses after which the remembered session card may be cleared.
const TERMINAL_STATUSES = new Set(['ready', 'succeeded', 'failed', 'cancelled', 'payment_unknown']);
const RUNNING_STATUSES = new Set(['queued', 'running', 'action_required']);
// `cardClearAfterOrder` support: drop the one-run card from session storage once
// a run has finished, but only when the user asked for it. Best-effort — the
// session store is wiped when the browser closes regardless. The encrypted
// device vault is deliberately untouched: "forget my card" is its own action.
async function clearCardAfterOrder(): Promise<void> {
  try { if ((await getSettings()).cardClearAfterOrder) await clearSessionCard(); }
  catch { /* best effort */ }
}

// Trigger-started runs have no app-page `duke-run` port, so a run that waits on
// the retailer (payment can take minutes) could be torn down by MV3's idle
// timeout. A cheap extension API call every 20 s resets that timer; the
// progress page also holds a port while it is open.
let runKeepalive: ReturnType<typeof setInterval> | null = null;
function updateRunKeepalive(run: CheckoutRun): void {
  if (RUNNING_STATUSES.has(run.status)) {
    if (runKeepalive) return;
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
    runKeepalive = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => undefined); }, 20_000);
    return;
  }
  if (runKeepalive) { clearInterval(runKeepalive); runKeepalive = null; }
}

// The RunManager is a module singleton. init() loads history and runs the
// server's interrupted-run recovery; it runs exactly once (memoized promise)
// even though a freshly-spawned service worker re-evaluates this module.
// The update hook drives the toolbar badge and the outcome notification
// (sendMessage does not self-deliver, so the worker reacts in-process).
const manager = new RunManager(adapter, registerNotifications(run => {
  setBadge(badgeStateForRun(run));
  updateRunKeepalive(run);
  if (TERMINAL_STATUSES.has(run.status)) void clearCardAfterOrder();
}));
let managerInit: Promise<void> | null = null;
function initManager(): Promise<void> {
  return (managerInit ??= (async () => {
    // Hydrate the armed cache once. A storage failure must never block the
    // service worker from starting; the cache simply stays null.
    try { armedCache = await getArmed(); } catch { armedCache = null; }
    setBadge(armedCache ? 'armed' : 'idle');
    await manager.init();
  })());
}
void initManager();

// Profile, settings, and history are extension-private. Content scripts are
// untrusted contexts (any page they run on can influence them), so lock both
// stores to the extension's own pages and worker. chrome.storage.session is
// trusted-only by default; setting it explicitly keeps the guarantee obvious.
void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
void chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

// Trigger surface: context-menu items, the keyboard command, and auto-arm on
// product-page load all funnel through the same dispatch/plan. Injected with
// the singletons above so armed state stays in one place. openProgress creates
// the run's presentation tab up front (instant feedback; the checkout later
// replaces it in place).
// A BIG W token lasts ~10 minutes and the site's SDK only renews it on its own
// requests. A tab left idle (or reloaded by an extension update) therefore has
// an expired token when the user clicks the chip, and the cart calls fail with
// LOGIN_REQUIRED. Reload the work tab once so the SDK refreshes, then wait for
// the bridge to report a live token. Best-effort: a signed-out user still gets
// the normal LOGIN_REQUIRED error.
async function prepareSession(): Promise<void> {
  if (manager.activeRunId) return;
  const tab = await acquireWorkTab().catch(() => null);
  if (typeof tab?.id !== 'number') return;
  const tabId = tab.id;
  const read = async (): Promise<{ authenticated?: boolean; tokenSecondsRemaining?: number } | null> =>
    await chrome.tabs.sendMessage(tabId, { type: 'bridge.context' }).catch(() => null) as { authenticated?: boolean; tokenSecondsRemaining?: number } | null;
  await ensureBridge(tabId).catch(() => undefined);
  const first = await read();
  if (first?.authenticated && (first.tokenSecondsRemaining ?? 0) > 60) return;
  await chrome.tabs.reload(tabId).catch(() => undefined);
  await ensureBridge(tabId).catch(() => undefined);
  for (let attempt = 0; attempt < 20; attempt++) {
    const next = await read();
    if (next?.authenticated && (next.tokenSecondsRemaining ?? 0) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

configureTriggers({
  adapter,
  manager,
  openProgress: async requestId => {
    const url = `${chrome.runtime.getURL('progress.html')}?request=${encodeURIComponent(requestId)}`;
    const tab = await chrome.tabs.create({ url, active: true });
    return tab.id;
  },
  prepareSession,
  notifySettings: next => { void broadcastSettings(next); },
});
registerContextMenus();
registerCommands();
registerAutoArm();

// Session keeper: a chrome.alarms beat wakes the sleeping service worker; when
// an armed state exists and the page's token nears expiry, the work tab reloads
// so BIG W's own SDK renews the token. The bridge always reads the live token,
// so after the reload it just works without further bookkeeping.
registerKeeper(
  async () => {
    const handle = await adapter.acquirePublic();
    return { tabId: handle.tabId };
  },
  async () => {
    // A reload would abort an in-flight run, so the keeper reports "not armed"
    // (and therefore never refreshes) while the RunManager has an active run.
    if (manager.activeRunId) return { armed: false, authenticated: false, tokenSecondsRemaining: 0 };
    // Read the same cache the adapter's arm()/disarm() write, so keeper refresh
    // and the RunManager fast path never disagree about whether a run is armed.
    const armed = armedCache;
    if (!armed) return { armed: false, authenticated: false, tokenSecondsRemaining: 0 };
    const handle = await adapter.acquirePublic().catch(() => null);
    if (!handle) return { armed: !!armed, authenticated: false, tokenSecondsRemaining: 0 };
    await waitForBridgeReady(handle.tabId).catch(() => undefined);
    const context = await handle.sender.sendMessage(handle.tabId, { type: 'bridge.context' }).catch(() => null) as { authenticated: boolean; tokenSecondsRemaining: number } | null;
    return { armed: !!armed, authenticated: !!context?.authenticated, tokenSecondsRemaining: context?.tokenSecondsRemaining ?? 0 };
  },
);

// Keep-alive. An open `duke-run` port from the app page holds the service
// worker alive for the length of a run, so MV3's idle teardown does not kill
// the RunManager mid-checkout. Known bound: Chrome keeps a port-connected
// worker alive for at most ~5 minutes; the run's own deadlines fit inside that
// window (pay waits at most 300 s), and the manager recovers a torn-down run
// from dukeRunState on the next start. The set keeps the ports referenced.
const runPorts = new Set<chrome.runtime.Port>();
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'duke-run') return;
  runPorts.add(port);
  port.onDisconnect.addListener(() => { runPorts.delete(port); });
});

const APP_URL = chrome.runtime.getURL('app.html');

async function appPageOpen(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    if (contexts.some(context => (context.documentUrl ?? '').startsWith(APP_URL))) return true;
  } catch { /* getContexts is Chrome 116+; fall through to the tab query */ }
  try {
    const tabs = await chrome.tabs.query({ url: `${APP_URL}*` });
    return tabs.length > 0;
  } catch { return false; }
}

// A run needs the app page open so its `duke-run` port outlives the run.start
// request and keeps the worker alive. The requesting page is usually the app
// itself; this only creates one when a run is started from elsewhere.
async function ensureAppPage(): Promise<void> {
  if (await appPageOpen()) return;
  await chrome.tabs.create({ url: APP_URL, active: false }).catch(() => undefined);
}

// Push new settings to every tab. Content scripts cannot read storage.local
// once it is locked to trusted contexts; this keeps an open page's toggles and
// quantity in step without a reload.
async function broadcastSettings(next: DukeSettings): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(tab => tab.id === undefined
      ? undefined
      : chrome.tabs.sendMessage(tab.id, { type: 'settings.update', payload: next }).catch(() => undefined)));
  } catch { /* tabs unavailable */ }
}

async function handle(request: DukeRequest): Promise<unknown> {
  await initManager();
  switch (request.type) {
    case 'bootstrap.get': return {
      settings: await getSettings(), profile: await getProfile(), history: await getHistory(),
      armed: armedCache, defaults: DEFAULT_SETTINGS, card: await cardStatus(),
    };
    case 'settings.get': return await getSettings();
    case 'settings.put': {
      const next = await putSettings(request.payload as never);
      void broadcastSettings(next);
      return next;
    }
    case 'profile.get': return await getProfile();
    case 'profile.put': return await putProfile(validateProfile(request.payload));
    case 'profile.import': {
      await prepareSession();
      // The extension has no BIG W page context, so the address-state fallback
      // (server: context.delivery?.state) comes from the stored profile instead.
      const existing = await getProfile();
      const imported = await adapter.importProfile(existing?.deliveryAddress.state);
      // Validate what BIG W returned so the UI can show exactly which fields the
      // user must fix (BIG W accounts may hold an overseas mobile, for example).
      try { validateProfile(imported.profile); return { ...imported, issues: {} }; }
      catch (error) { return { ...imported, issues: publicError(error).fields ?? {} }; }
    }
    // Card material stays behind the service worker: the app page never touches
    // chrome.storage.session directly for the one-run card. `persist` writes the
    // sealed device vault (card-vault.ts) so one-click survives a restart.
    case 'card.session.put': { await putSessionCard(request.payload as SessionCard); return { ok: true }; }
    case 'card.session.get': return await getSessionCard();
    case 'card.session.clear': { await clearSessionCard(); return { ok: true }; }
    case 'card.save': {
      const { card, persist } = request.payload as { card: SessionCard; persist: boolean };
      return await saveCard(card, { persist: !!persist });
    }
    case 'card.get': return await getCard();
    case 'card.forget': { await forgetCard(); return { ok: true }; }
    case 'card.device.clear': { await clearDeviceCard(); return await cardStatus(); }
    case 'card.status': return await cardStatus();
    case 'session.status': {
      // Read-only probe of the user's existing BIG W tab. Never opens a tab.
      const tabs = await chrome.tabs.query({ url: 'https://www.bigw.com.au/*' }).catch(() => []);
      const tab = tabs.find(item => item.id !== undefined);
      if (tab?.id === undefined) return { available: false, authenticated: false, tokenSecondsRemaining: 0 };
      // A tab loaded before an extension reload has no live content script.
      // Heal it for an explicit status check (never while a run is in flight).
      if (!manager.activeRunId) await ensureBridge(tab.id).catch(() => undefined);
      const context = await chrome.tabs.sendMessage(tab.id, { type: 'bridge.context' }).catch(() => null) as { authenticated?: boolean; tokenSecondsRemaining?: number } | null;
      return { available: true, authenticated: !!context?.authenticated, tokenSecondsRemaining: context?.tokenSecondsRemaining ?? 0 };
    }
    case 'ui.open': { await openAppPage(); return { ok: true }; }
    case 'inspect.start': {
      const { productUrl, profile } = request.payload as { productUrl: string; profile: never };
      return await adapter.inspect(productUrl, profile);
    }
    case 'arm.start': {
      // Shared with every trigger path: armProduct builds/passes the request,
      // calls the adapter (which publishes into the armed store + session
      // storage), and broadcasts arm.update.
      const input = request.payload as RunRequest;
      return await armProduct(input.productUrl, input);
    }
    case 'arm.clear': adapter.disarm(); broadcast({ type: 'arm.update', payload: null }); setBadge('idle'); return { ok: true };
    case 'arm.get': return armedCache;
    case 'run.start':
      await ensureAppPage();
      await prepareSession();
      return await manager.start(request.payload);
    case 'run.list': return manager.history();
    case 'run.get': {
      const { id } = request.payload as { id: string };
      return manager.get(id);
    }
    case 'run.byRequest': {
      // The progress page knows the requestId it was opened with, not the run id
      // the manager assigned.
      const { requestId } = request.payload as { requestId: string };
      return manager.history().find(run => run.requestId === requestId) ?? null;
    }
    case 'run.cancel': {
      const { id } = request.payload as { id: string };
      return manager.cancel(id);
    }
    case 'run.resolve': {
      const { id, resolution, orderNumber } = request.payload as { id: string; resolution: 'confirmed' | 'not_purchased'; orderNumber?: string };
      return await manager.resolve(id, resolution, orderNumber);
    }
    case 'cards.list': return await adapter.listCards();
    default: throw new AppError('UNSUPPORTED', 'This request is not supported by this build.');
  }
}

function broadcast(event: { type: string; payload: unknown }) {
  if (!isEvent(event)) return;
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const request = decodeRequest(raw);
  if (!request) return false;
  void handle(request)
    .then(result => sendResponse(encodeResponse({ id: request.id, ok: true, result })))
    .catch(error => sendResponse(encodeResponse({ id: request.id, ok: false, error: publicError(error) })));
  return true;
});

// MAIN-world guard events are ADVISORY ONLY (Task-3 trust boundary): any page
// script on bigw.com.au can forge them, so they only ever inform the adapter's
// blocked-vs-unknown reconciliation; the authoritative record stays the
// observe.list ring buffer and the run's own request results. Recorded per tab
// with the worker's own clock so the adapter can ignore events from before it
// enabled the guard.
chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
  const message = raw as { type?: string; event?: { type?: string; code?: string } } | null;
  if (message?.type !== 'guard.event') return false;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;
  guardEventLog.push({ tabId, type: String(message.event?.type ?? ''), code: message.event?.code, at: Date.now() });
  while (guardEventLog.length > GUARD_EVENT_LIMIT) guardEventLog.shift();
  console.log('[duke] guard', message.event?.type, message.event?.code ?? '');
  return false;
});

chrome.runtime.onInstalled.addListener(details => {
  console.log('[duke] installed');
  // First run: open setup so the user imports their BIG W profile and card
  // before any trigger can fire. A reinstall/update keeps the stored profile.
  if (details.reason === 'install') {
    void getProfile().then(async profile => {
      // Do not hijack a tab the user already opened (and never race a page that
      // is mid-setup): only auto-open setup when nothing is showing yet.
      if (!profile && !(await appPageIsOpen())) await openAppPage({ onboarding: '1' });
    }).catch(() => undefined);
  }
});

// Trigger intents from content scripts (link-scout hover chip), the context
// menu, and the keyboard command. These carry no request id, so they are
// separate from the RPC listener above. The chip awaits this response so it can
// show "preparing" or the exact missing piece in place, instead of dropping the
// click into a notification.
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const message = raw as { type?: string; url?: string; quantity?: number } | null;
  if (!message || typeof message.type !== 'string') return false;
  if (message.type === 'trigger.checkout' || message.type === 'trigger.arm') {
    const action = message.type === 'trigger.arm' ? 'arm' : 'checkout';
    void dispatchTriggerSafely(action, typeof message.url === 'string' ? message.url : '', sender.tab?.id, {
      quantity: typeof message.quantity === 'number' ? message.quantity : undefined,
    })
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false, code: 'TRIGGER_FAILED', message: 'This action could not start. Open Duke and try again.' }));
    return true;
  }
  if (message.type === 'trigger.hovered' && sender.tab?.id !== undefined && typeof message.url === 'string') {
    setLastHovered(sender.tab.id, message.url);
  }
  return false;
});
