import { decodeRequest, encodeResponse, isEvent, type DukeRequest } from '../lib/protocol.ts';
import { getSettings, putSettings, getProfile, putProfile, getHistory, DEFAULT_SETTINGS } from '../lib/storage.ts';
import { acquireWorkTab, waitForBridgeReady } from './work-tab.ts';
import { getArmed, setArmed, clearArmed } from './state.ts';
import { registerKeeper } from './keeper.ts';
import { BigWExtensionAdapter } from '../lib/retailers/bigw/adapter.ts';
import { AppError, publicError } from '../../server/errors.ts';

const adapter = new BigWExtensionAdapter(async () => {
  const tab = await acquireWorkTab();
  if (!tab.id) throw new AppError('BRIDGE_UNREADY', 'No BIG W tab is available. Open bigw.com.au once.');
  await waitForBridgeReady(tab.id);
  return { tabId: tab.id, sender: { sendMessage: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg as never) } };
});

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
    const armed = await getArmed();
    if (!armed) return { armed: false, authenticated: false, tokenSecondsRemaining: 0 };
    const handle = await adapter.acquirePublic().catch(() => null);
    if (!handle) return { armed: !!armed, authenticated: false, tokenSecondsRemaining: 0 };
    await waitForBridgeReady(handle.tabId).catch(() => undefined);
    const context = await handle.sender.sendMessage(handle.tabId, { type: 'bridge.context' }).catch(() => null) as { authenticated: boolean; tokenSecondsRemaining: number } | null;
    return { armed: !!armed, authenticated: !!context?.authenticated, tokenSecondsRemaining: context?.tokenSecondsRemaining ?? 0 };
  },
);

async function handle(request: DukeRequest): Promise<unknown> {
  switch (request.type) {
    case 'bootstrap.get': return {
      settings: await getSettings(), profile: await getProfile(), history: await getHistory(),
      armed: await getArmed(), defaults: DEFAULT_SETTINGS,
    };
    case 'settings.get': return await getSettings();
    case 'settings.put': return await putSettings(request.payload as never);
    case 'profile.get': return await getProfile();
    case 'profile.put': return await putProfile(request.payload as never);
    case 'inspect.start': {
      const { productUrl, profile } = request.payload as { productUrl: string; profile: never };
      return await adapter.inspect(productUrl, profile);
    }
    case 'arm.start': {
      const input = request.payload as never;
      // No cancellation path in stage 1; signal satisfies the interface.
      const armed = await adapter.arm(input, () => undefined, new AbortController().signal);
      await setArmed(armed);
      broadcast({ type: 'arm.update', payload: armed });
      return armed;
    }
    case 'arm.clear': await clearArmed(); broadcast({ type: 'arm.update', payload: null }); return { ok: true };
    case 'arm.get': return await getArmed();
    default: throw new AppError('UNSUPPORTED', 'This build covers settings, inspection, and arming. Checkout runs arrive in stage 2.');
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

chrome.runtime.onInstalled.addListener(() => { console.log('[duke] installed'); });
