// ISOLATED-world relay: forwards chrome.runtime messages from the service
// worker into the MAIN-world bridge (window.postMessage protocol, channel
// 'duke') and returns the reply via the open sendResponse channel.
chrome.runtime.onMessage.addListener((msg: { type?: string; args?: unknown }, _sender, sendResponse) => {
  if (msg?.type === 'bridge.ping') { sendResponse({ pong: true }); return false; }
  if (msg?.type !== 'bridge.request') return false;
  const requestId = crypto.randomUUID();
  const onReply = (event: MessageEvent) => {
    if (event.source !== window || event.data?.channel !== 'duke' || event.data.requestId !== requestId) return;
    window.removeEventListener('message', onReply);
    sendResponse(event.data.result);
  };
  window.addEventListener('message', onReply);
  window.postMessage({ channel: 'duke', requestId, args: msg.args }, '*');
  return true; // keep the channel open for the async sendResponse
});
