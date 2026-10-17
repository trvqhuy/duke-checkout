// ISOLATED-world relay: forwards chrome.runtime messages from the service
// worker into the MAIN-world bridge (window.postMessage protocol, channel
// 'duke') and returns the reply via the open sendResponse channel. It also
// forwards MAIN-world guard events (kind 'guard.event') up to the service
// worker as `guard.event` messages.
function relayIntoMain(sendResponse: (result: unknown) => void, payload: { kind?: string; args?: unknown; control?: unknown }) {
  const requestId = crypto.randomUUID();
  const onReply = (event: MessageEvent) => {
    // Only the MAIN-world reply carries a `result` key: the relay's own
    // outgoing request also echoes back into this world (the two content
    // worlds share one window), and it must not satisfy the reply predicate.
    if (event.source !== window || event.data?.channel !== 'duke' || event.data.requestId !== requestId || !('result' in event.data)) return;
    window.removeEventListener('message', onReply);
    sendResponse(event.data.result);
  };
  window.addEventListener('message', onReply);
  window.postMessage({ channel: 'duke', requestId, ...payload }, '*');
  return true; // keep the channel open for the async sendResponse
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Guard events have no requestId/result, so they never satisfy a relay reply.
  // Forward them to the SW; the router filters `guard.event` (Task 6).
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.channel !== 'duke' || event.data.kind !== 'guard.event') return;
    try { void chrome.runtime?.sendMessage?.({ type: 'guard.event', event: event.data.event })?.catch?.(() => undefined); } catch { /* SW unavailable */ }
  });
}

chrome.runtime.onMessage.addListener((msg: { type?: string; args?: unknown; control?: unknown }, _sender, sendResponse) => {
  if (msg?.type === 'bridge.ping') { sendResponse({ pong: true }); return false; }
  if (msg?.type === 'bridge.request') return relayIntoMain(sendResponse, { args: msg.args });
  if (msg?.type === 'bridge.context') return relayIntoMain(sendResponse, { kind: 'context' });
  if (msg?.type === 'bridge.control') return relayIntoMain(sendResponse, { kind: 'control', control: msg.control });
  return false;
});
