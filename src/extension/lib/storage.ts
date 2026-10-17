import { z } from 'zod';
import type { CheckoutRun, Profile } from '../../shared/types.ts';
import { retainRunHistory } from '../../shared/history.ts';
import { sanitizeRun } from '../../shared/run-sanitize.ts';

const settingsSchema = z.object({
  quantity: z.number().int({ message: 'Quantity must be a whole number between 1 and 20.' }).min(1, { message: 'Quantity must be a whole number between 1 and 20.' }).max(20, { message: 'Quantity must be a whole number between 1 and 20.' }),
  maxTotalAUD: z.string().regex(/^\d{1,5}(?:\.\d{1,2})?$/).refine(v => Number(v) > 0 && Number(v) <= 50_000, { message: 'Enter a delivered budget between $0.01 and $50,000.' }),
  mode: z.enum(['prepare', 'assist', 'purchase', 'afterpay']),
  confirmBeforePay: z.boolean(), hoverChip: z.boolean(), autoArm: z.boolean(), cardClearAfterOrder: z.boolean(),
});
export type DukeSettings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: DukeSettings = {
  quantity: 1, maxTotalAUD: '1000.00', mode: 'purchase',
  confirmBeforePay: false, hoverChip: true, autoArm: true, cardClearAfterOrder: false,
};
const SETTINGS_KEY = 'dukeSettings';

async function localGet<T>(key: string): Promise<T | undefined> {
  const items = await chrome.storage.local.get([key]);
  return items[key] as T | undefined;
}
async function localSet(key: string, value: unknown): Promise<void> { await chrome.storage.local.set({ [key]: value }); }

async function sessionGet<T>(key: string): Promise<T | undefined> {
  const items = await chrome.storage.session.get([key]);
  return items[key] as T | undefined;
}

export async function getSettings(): Promise<DukeSettings> {
  const merged = { ...DEFAULT_SETTINGS, ...await localGet<Partial<DukeSettings>>(SETTINGS_KEY) };
  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    console.warn('[duke] stored settings invalid; using defaults');
    return DEFAULT_SETTINGS;
  }
  return parsed.data;
}
export async function putSettings(patch: Partial<DukeSettings>): Promise<DukeSettings> {
  const next = settingsSchema.parse({ ...(await getSettings()), ...patch });
  await localSet(SETTINGS_KEY, next);
  return next;
}

export type DukeProfileRecord = Profile;

const PROFILE_KEY = 'dukeProfile';
const HISTORY_KEY = 'dukeHistory';

export async function getProfile(): Promise<Profile | null> { return (await localGet<Profile>(PROFILE_KEY)) ?? null; }
export async function putProfile(profile: Profile): Promise<Profile> { await localSet(PROFILE_KEY, profile); return profile; }

export interface HistoryEntry { id: string; status: string; [key: string]: unknown }
export async function getHistory(): Promise<CheckoutRun[]> { return (await localGet<CheckoutRun[]>(HISTORY_KEY)) ?? []; }

// Mirrors the server's LocalStore.saveRuns: apply the shared retention policy,
// then sanitize, and write the whole retained snapshot in one set.
export async function saveRuns(runs: CheckoutRun[]): Promise<void> {
  const snapshot = retainRunHistory(runs).map(sanitizeRun);
  await localSet(HISTORY_KEY, snapshot);
}

// Upsert-by-id append used by remaining callers; retention decides what is kept.
export async function pushRun(run: CheckoutRun): Promise<void> {
  await saveRuns([run, ...(await getHistory()).filter(item => item.id !== run.id)]);
}

// --- one-run session card ---------------------------------------------------
// Card material captured for the single checkout run that needs it. It lives
// ONLY in chrome.storage.session (never storage.local) so it is wiped when the
// browser session ends and never persists alongside settings/history.
export interface SessionCard { number: string; expiry: string; cvv: string }

const CARD_KEY = 'dukeCard';

export async function getSessionCard(): Promise<SessionCard | null> {
  const stored = await sessionGet<SessionCard>(CARD_KEY);
  if (!stored || typeof stored.number !== 'string' || typeof stored.expiry !== 'string' || typeof stored.cvv !== 'string') return null;
  return { number: stored.number, expiry: stored.expiry, cvv: stored.cvv };
}
export async function putSessionCard(card: SessionCard): Promise<void> {
  await chrome.storage.session.set({ [CARD_KEY]: { number: card.number, expiry: card.expiry, cvv: card.cvv } });
}
export async function clearSessionCard(): Promise<void> {
  await chrome.storage.session.remove([CARD_KEY]);
}
