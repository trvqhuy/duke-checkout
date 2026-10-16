// ISOLATED-world relay: forwards chrome.runtime messages from the service
// worker into the MAIN-world bridge (window.postMessage protocol, channel
// 'duke') and returns the reply via the open sendResponse channel.
function relayIntoMain(sendResponse: (result: unknown) => void, payload: { kind?: string; args?: unknown }) {
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

chrome.runtime.onMessage.addListener((msg: { type?: string; args?: unknown }, _sender, sendResponse) => {
  if (msg?.type === 'bridge.ping') { sendResponse({ pong: true }); return false; }
  if (msg?.type === 'bridge.request') return relayIntoMain(sendResponse, { args: msg.args });
  if (msg?.type === 'bridge.context') return relayIntoMain(sendResponse, { kind: 'context' });
  return false;
});
