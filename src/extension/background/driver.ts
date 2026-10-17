// Stage-2 driver capability: the chrome-API-backed implementation of the
// driver-free `DriverHandle` contract the BIG W adapter consumes (see
// ../lib/retailers/types.ts). Everything chrome-specific lives here so the
// adapter and its tests stay headless.
//
// Two channels reach a work tab:
// - driver.* messages go to the checkout-driver content script via
//   chrome.tabs.sendMessage(tabId, msg, { frameId }) (top frame or a Gr4vy
//   field frame). The content script answers through the sendResponse channel.
// - control messages go through the isolated relay as { type:'bridge.control',
//   control } to the MAIN-world guard/observer (observe.list/clear,
//   guard.enable/disable, observe.antiFraud). This is the same top-frame
//   chrome.tabs.sendMessage path the bridge uses.
//
// Every sendMessage is wrapped in a bounded timeout: a missing content script
// rejects outright and a mounted frame that never answers would otherwise hang
// a run, so both surface as DRIVER_TIMEOUT.
import { AppError } from '../../server/errors.ts';
import type { DriverFrame, DriverHandle, GuardEventRecord, ObservedEntry } from '../lib/retailers/types.ts';
import type { PaymentBinding } from '../../shared/payment-check.ts';

const GR4VY_HOST = 'secure-fields.wpay2.gr4vy.app';
const DEFAULT_TIMEOUT_MS = 10_000;

// The Gr4vy secure-field iframes identify themselves by their `type` query
// parameter on the shared /input.html document. Pure so it can be unit tested
// without chrome.
export function frameType(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== GR4VY_HOST || parsed.pathname !== '/input.html') return undefined;
    return parsed.searchParams.get('type') ?? undefined;
  } catch { return undefined; }
}

interface ControlMessage { kind: 'observe.list' | 'observe.clear' | 'guard.enable' | 'guard.disable' | 'observe.antiFraud'; binding?: PaymentBinding }

function driverTimeout(reason: string): AppError {
  return new AppError('DRIVER_TIMEOUT', `The BIG W checkout driver did not respond (${reason}). Reload the checkout tab and try again.`);
}

// Reads the guard events the service worker recorded for a tab. Injected so
// this module stays chrome-only (and unit tests can stub the reader) while the
// in-memory event list lives in the worker.
export type GuardEventProvider = (tabId: number) => GuardEventRecord[];

export function driverHandleFor(tabId: number, timeoutMs = DEFAULT_TIMEOUT_MS, guardEventProvider?: GuardEventProvider): DriverHandle {
  async function call(message: unknown, frameId?: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // chrome.tabs.sendMessage resolves with the content script's sendResponse
      // value; it rejects when no receiver exists. The race adds a bound for the
      // mounted-but-silent case.
      const reply = frameId === undefined
        ? chrome.tabs.sendMessage(tabId, message as never)
        : chrome.tabs.sendMessage(tabId, message as never, { frameId });
      return await Promise.race([
        reply,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(driverTimeout('timeout')), timeoutMs); }),
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw driverTimeout('no receiver');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const control = (message: ControlMessage) => call({ type: 'bridge.control', control: message });

  return {
    async frames() {
      const all = await chrome.webNavigation.getAllFrames({ tabId });
      if (!all) return [];
      return all.map(frame => ({ frameId: frame.frameId, url: frame.url, type: frameType(frame.url) }));
    },
    sendTop: message => call(message),
    sendFrame: (frameId, message) => call(message, frameId),
    async navigate(url) { await chrome.tabs.update(tabId, { url }); },
    async activate() { await chrome.tabs.update(tabId, { active: true }); },
    async url() { const tab = await chrome.tabs.get(tabId); return tab.url ?? ''; },
    async observe() { return await control({ kind: 'observe.list' }) as { entries: ObservedEntry[] }; },
    async observeClear() { await control({ kind: 'observe.clear' }); },
    async guardEnable(binding) { await control({ kind: 'guard.enable', binding }); },
    async guardDisable() { await control({ kind: 'guard.disable' }); },
    async guardEvents() { return guardEventProvider?.(tabId) ?? []; },
    async antiFraud() { return await control({ kind: 'observe.antiFraud' }) as { fingerprint: string }; },
  };
}
