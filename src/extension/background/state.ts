import type { ArmedCheckout } from '../../shared/types.ts';

const ARMED_KEY = 'dukeArmed';

export async function getArmed(): Promise<ArmedCheckout | null> {
  const stored = (await chrome.storage.session.get([ARMED_KEY]))[ARMED_KEY] as ArmedCheckout | undefined;
  return stored ?? null;
}
export async function setArmed(armed: ArmedCheckout): Promise<void> {
  await chrome.storage.session.set({ [ARMED_KEY]: armed });
}
export async function clearArmed(): Promise<void> {
  await chrome.storage.session.remove([ARMED_KEY]);
}
