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
