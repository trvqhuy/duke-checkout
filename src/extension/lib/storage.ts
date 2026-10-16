import { z } from 'zod';
import type { Profile } from '../../shared/types.ts';

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
const HISTORY_CAP = 100;

export async function getProfile(): Promise<Profile | null> { return (await localGet<Profile>(PROFILE_KEY)) ?? null; }
export async function putProfile(profile: Profile): Promise<Profile> { await localSet(PROFILE_KEY, profile); return profile; }

export interface HistoryEntry { id: string; status: string; [key: string]: unknown }
export async function getHistory(): Promise<HistoryEntry[]> { return (await localGet<HistoryEntry[]>(HISTORY_KEY)) ?? []; }
export async function pushRun(run: HistoryEntry): Promise<void> {
  const history = [run, ...(await getHistory())].slice(0, HISTORY_CAP);
  await localSet(HISTORY_KEY, history);
}
