import { decodeRequest, encodeResponse, isEvent, type DukeRequest } from '../lib/protocol.ts';
import { getSettings, putSettings, getProfile, putProfile, getHistory, getSessionCard, putSessionCard, clearSessionCard, DEFAULT_SETTINGS, type SessionCard } from '../lib/storage.ts';
import { acquireWorkTab, waitForBridgeReady } from './work-tab.ts';
import { getArmed, setArmed, clearArmed } from './state.ts';
import { registerKeeper } from './keeper.ts';
import { BigWExtensionAdapter } from '../lib/retailers/bigw/adapter.ts';
import { RunManager } from './run-manager.ts';
import { driverHandleFor } from './driver.ts';
import { setBadge, badgeStateForRun } from './badge.ts';
import { configureTriggers, registerContextMenus, registerCommands, registerAutoArm, dispatchTrigger, armProduct, setLastHovered } from './triggers.ts';
import { registerNotifications } from './notify.ts';
import { AppError, publicError } from '../../server/errors.ts';
import type { ArmedCheckout, RunRequest } from '../../shared/types.ts';

// The armed checkout, mirrored from chrome.storage.session into memory so the
// adapter's synchronous armedState() can answer the RunManager's fast-path
// check without async storage. The store's set() is the single writer: it keeps
// the cache and session storage in lockstep.
let armedCache: ArmedCheckout | null = null;

// Every acquire returns the tab id, the bridge sender, and a fresh Stage-2
// driver handle for that tab (the driver is chrome-backed, so it is built here
// where chrome exists, keeping the adapter headless).
const adapter = new BigWExtensionAdapter(
  async () => {
    const tab = await acquireWorkTab();
    if (!tab.id) throw new AppError('BRIDGE_UNREADY', 'No BIG W tab is available. Open bigw.com.au once.');
    await waitForBridgeReady(tab.id);
    return { tabId: tab.id, sender: { sendMessage: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg as never) }, driver: driverHandleFor(tab.id) };
  },
  {
    get: () => armedCache,
    set: value => { armedCache = value; void (value ? setArmed(value) : clearArmed()); },
  },
);

// Terminal statuses after which the remembered session card may be cleared.
const TERMINAL_STATUSES = new Set(['ready', 'succeeded', 'failed', 'cancelled', 'payment_unknown']);
// `cardClearAfterOrder` support: drop the one-run card from session storage once
// a run has finished, but only when the user asked for it. Best-effort — the
// session store is wiped when the browser closes regardless.
async function clearCardAfterOrder(): Promise<void> {
  try { if ((await getSettings()).cardClearAfterOrder) await clearSessionCard(); }
  catch { /* best effort */ }
}

// The RunManager is a module singleton. init() loads history and runs the
// server's interrupted-run recovery; it runs exactly once (memoized promise)
// even though a freshly-spawned service worker re-evaluates this module.
// The update hook drives the toolbar badge and the outcome notification
// (sendMessage does not self-deliver, so the worker reacts in-process).
const manager = new RunManager(adapter, registerNotifications(run => {
  setBadge(badgeStateForRun(run));
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

// Trigger surface: context-menu items, the keyboard command, and auto-arm on
// product-page load all funnel through the same dispatch/plan. Injected with
// the singletons above so armed state stays in one place.
configureTriggers({ adapter, manager });
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

async function handle(request: DukeRequest): Promise<unknown> {
  await initManager();
  switch (request.type) {
    case 'bootstrap.get': return {
      settings: await getSettings(), profile: await getProfile(), history: await getHistory(),
      armed: armedCache, defaults: DEFAULT_SETTINGS,
    };
    case 'settings.get': return await getSettings();
    case 'settings.put': return await putSettings(request.payload as never);
    case 'profile.get': return await getProfile();
    case 'profile.put': return await putProfile(request.payload as never);
    case 'profile.import': {
      // The extension has no BIG W page context, so the address-state fallback
      // (server: context.delivery?.state) comes from the stored profile instead.
      const existing = await getProfile();
      return await adapter.importProfile(existing?.deliveryAddress.state);
    }
    // Card material stays behind the service worker: the app page never touches
    // chrome.storage.session directly for the one-run card.
    case 'card.session.put': { await putSessionCard(request.payload as SessionCard); return { ok: true }; }
    case 'card.session.get': return await getSessionCard();
    case 'card.session.clear': { await clearSessionCard(); return { ok: true }; }
    case 'inspect.start': {
      const { productUrl, profile } = request.payload as { productUrl: string; profile: never };
      return await adapter.inspect(productUrl, profile);
    }
    case 'arm.start': {
      // Shared with every trigger path: armProduct builds/passes the request,
      // calls the adapter (which publishes into the armed store + session
      // storage), and broadcasts arm.update.
      const input = request.payload as RunRequest;
      const armed = await armProduct(input.productUrl, input);
      setBadge('armed');
      return armed;
    }
    case 'arm.clear': adapter.disarm(); broadcast({ type: 'arm.update', payload: null }); setBadge('idle'); return { ok: true };
    case 'arm.get': return armedCache;
    case 'run.start':
      await ensureAppPage();
      return await manager.start(request.payload);
    case 'run.list': return manager.history();
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
// script on bigw.com.au can forge them, so the service worker only logs them
// and takes no action. The adapter reconciles real outcomes from the
// observe.list ring buffer and the run's own request results, never from these
// events.
chrome.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as { type?: string; event?: { type?: string; code?: string } } | null;
  if (message?.type !== 'guard.event') return false;
  console.log('[duke] guard', message.event?.type, message.event?.code ?? '');
  return false;
});

chrome.runtime.onInstalled.addListener(() => { console.log('[duke] installed'); });

// Trigger intents from content scripts (link-scout hover chip) and the page.
// These carry no request id, so they are separate from the RPC listener above.
// trigger.hovered only remembers the link under the pointer for the command;
// trigger.checkout/arm run the same dispatch the menu and command use.
chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
  const message = raw as { type?: string; url?: string } | null;
  if (!message || typeof message.type !== 'string') return false;
  if (message.type === 'trigger.checkout' || message.type === 'trigger.arm') {
    void dispatchTrigger(message.type === 'trigger.arm' ? 'arm' : 'checkout', typeof message.url === 'string' ? message.url : '', sender.tab?.id).catch(() => undefined);
  } else if (message.type === 'trigger.hovered' && sender.tab?.id !== undefined && typeof message.url === 'string') {
    setLastHovered(sender.tab.id, message.url);
  }
  return false;
});
