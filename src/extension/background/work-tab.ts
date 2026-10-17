const BIG_W_TAB_MATCH = 'https://www.bigw.com.au/*';
const WORK_URL = 'https://www.bigw.com.au/';

export async function acquireWorkTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: BIG_W_TAB_MATCH });
  const checkout = tabs.find(tab => /\/checkout\//.test(tab.url ?? ''));
  const existing = checkout ?? tabs[0];
  if (existing?.id) return existing;
  return chrome.tabs.create({ active: false, url: WORK_URL }) as Promise<chrome.tabs.Tab>;
}

export async function waitForBridgeReady(tabId: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const reply = await chrome.tabs.sendMessage(tabId, { type: 'bridge.ping' }); if (reply?.pong) return; } catch { /* content script not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw Object.assign(new Error('The BIG W page did not accept the bridge. Reload the BIG W tab.'), { code: 'BRIDGE_UNREADY' });
}

async function pingBridge(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const reply = await chrome.tabs.sendMessage(tabId, { type: 'bridge.ping' }); if (reply?.pong) return true; } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

async function waitForComplete(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'complete') return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

// A tab loaded before the extension was installed or reloaded has no live
// content scripts: chrome.tabs.sendMessage reports "Receiving end does not
// exist" even though the page is fine. Reload it once so the bridge re-injects,
// then wait for it to answer. Runs self-heal after an update instead of failing.
export async function ensureBridge(tabId: number): Promise<void> {
  if (await pingBridge(tabId, 2_500)) return;
  console.log('[duke] work tab has no live bridge; reloading it');
  await chrome.tabs.reload(tabId).catch(() => undefined);
  await waitForComplete(tabId, 30_000);
  await waitForBridgeReady(tabId, 25_000);
}
