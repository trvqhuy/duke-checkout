// Stage-2 checkout driver content script. Injected into the BIG W checkout
// frame (www.bigw.com.au/checkout/*) and the Gr4vy secure-fields iframe
// (secure-fields.wpay2.gr4vy.app). Task 2 fills the behaviour; for now this
// file carries the frame detectors, a dormant onMessage placeholder, and the
// pure helpers the unit tests exercise directly.

export function isFieldFrame(): boolean {
  return location.host === 'secure-fields.wpay2.gr4vy.app' && location.pathname === '/input.html';
}

export function isCheckoutFrame(): boolean {
  return location.host === 'www.bigw.com.au' && location.pathname.startsWith('/checkout/');
}

export function onMessage(
  _message: unknown,
  _sender: chrome.runtime.MessageSender,
  _sendResponse: (response?: unknown) => void,
): boolean {
  return false;
}

export const __test = { isFieldFrame, isCheckoutFrame, onMessage };

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(onMessage);
}
