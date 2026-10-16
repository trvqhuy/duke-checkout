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
