import { z } from 'zod';

export interface DukeSettings {
  quantity: number; maxTotalAUD: string; mode: 'prepare' | 'assist' | 'purchase' | 'afterpay';
  confirmBeforePay: boolean; hoverChip: boolean; autoArm: boolean; cardClearAfterOrder: boolean;
}
export const DEFAULT_SETTINGS: DukeSettings = {
  quantity: 1, maxTotalAUD: '1000.00', mode: 'purchase',
  confirmBeforePay: false, hoverChip: true, autoArm: true, cardClearAfterOrder: false,
};
const settingsSchema = z.object({
  quantity: z.number().int().min(1).max(20),
  maxTotalAUD: z.string().regex(/^\d{1,5}(?:\.\d{1,2})?$/).refine(v => Number(v) > 0 && Number(v) <= 50_000),
  mode: z.enum(['prepare', 'assist', 'purchase', 'afterpay']),
  confirmBeforePay: z.boolean(), hoverChip: z.boolean(), autoArm: z.boolean(), cardClearAfterOrder: z.boolean(),
});
const SETTINGS_KEY = 'dukeSettings';

async function localGet<T>(key: string): Promise<T | undefined> {
  const items = await chrome.storage.local.get([key]);
  return items[key] as T | undefined;
}
async function localSet(key: string, value: unknown): Promise<void> { await chrome.storage.local.set({ [key]: value }); }

export async function getSettings(): Promise<DukeSettings> {
  const merged = { ...DEFAULT_SETTINGS, ...await localGet<Partial<DukeSettings>>(SETTINGS_KEY) };
  return settingsSchema.parse(merged);
}
export async function putSettings(patch: Partial<DukeSettings>): Promise<DukeSettings> {
  const next = settingsSchema.parse({ ...(await getSettings()), ...patch });
  await localSet(SETTINGS_KEY, next);
  return next;
}
