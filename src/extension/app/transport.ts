import { decodeResponse, isEvent, type DukeEvent, type RequestType } from '../lib/protocol.ts';

export async function request<T>(type: RequestType, payload?: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage({ id: crypto.randomUUID(), type, payload: payload ?? null });
  const decoded = decodeResponse(response);
  if (!decoded) throw new Error('Unreadable response from the extension background.');
  if (!decoded.ok) throw Object.assign(new Error(decoded.error?.message ?? 'Request failed'), { code: decoded.error?.code, fields: decoded.error?.fields });
  return decoded.result as T;
}

export function onEvent(handler: (event: DukeEvent) => void): () => void {
  const listener = (message: unknown) => { if (isEvent(message)) handler(message); };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

// Holds the service worker alive for the length of a checkout run. The SW
// accepts ports named `duke-run` (service-worker.ts onConnect) so MV3's idle
// teardown cannot kill the RunManager mid-run. Returns the disconnect fn; call
// it once the run reaches a terminal state.
export function connectRunPort(): () => void {
  const port = chrome.runtime.connect({ name: 'duke-run' });
  return () => { try { port.disconnect(); } catch { /* already closed */ } };
}
