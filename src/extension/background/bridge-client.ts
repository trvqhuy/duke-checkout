import { AppError } from '../../server/errors.ts';

type Sender = { sendMessage: (tabId: number, msg: unknown) => Promise<unknown> };
const MESSAGES: Record<string, string> = {
  LOGIN_REQUIRED: 'BIG W needs you to sign in again in the BIG W tab.',
  SESSION_EXPIRED: 'The BIG W session expired. Open BIG W and prepare again.',
  BROWSER_ATTENTION: 'BIG W needs attention in Chrome. Complete any sign-in or browser check there, then prepare again.',
  REQUEST_TIMEOUT: 'BIG W took too long to respond to this preparation step.',
  REQUEST_NETWORK: 'The browser could not reach BIG W. Check its connection and try again.',
};

export async function bridgeRequest(sender: Sender, tabId: number, args: unknown, timeoutMs = 30_000): Promise<unknown> {
  let result: { ok: boolean; status: number; data?: unknown; code?: string } | null;
  try {
    result = await Promise.race([
      sender.sendMessage(tabId, { type: 'bridge.request', args }) as Promise<{ ok: boolean; status: number; data?: unknown; code?: string } | null>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new AppError('BRIDGE_NO_RESPONSE', 'The BIG W page bridge did not respond. Reload the BIG W tab.')), timeoutMs)),
    ]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('BRIDGE_NO_RESPONSE', 'The BIG W page bridge did not respond. Reload the BIG W tab.');
  }
  if (!result) throw new AppError('BRIDGE_NO_RESPONSE', 'The BIG W page bridge did not respond. Reload the BIG W tab.');
  if (!result.ok) throw new AppError(result.code ?? 'STORE_REQUEST', MESSAGES[result.code ?? ''] ?? `BIG W rejected the request (HTTP ${result.status}). Check the BIG W tab.`, result.status >= 500 ? 502 : 400);
  return result.data;
}
