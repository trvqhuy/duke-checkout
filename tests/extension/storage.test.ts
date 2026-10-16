import { beforeEach, describe, expect, it } from 'vitest';
import { getSettings, putSettings, DEFAULT_SETTINGS, getProfile, putProfile, getHistory, pushRun, type DukeSettings, type DukeProfileRecord } from '../../src/extension/lib/storage.ts';

const mem: Record<string, unknown> = {};
const chromeStub = { storage: { local: {
  get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in mem).map(k => [k, mem[k]])),
  set: async (items: Record<string, unknown>) => { Object.assign(mem, items); },
} } };
(globalThis as Record<string, unknown>).chrome = chromeStub;

describe('settings storage', () => {
  beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });
  it('returns full defaults when nothing stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
  it('merges partial stored settings over defaults', async () => {
    mem.dukeSettings = { quantity: 2 };
    const s = await getSettings();
    expect(s.quantity).toBe(2);
    expect(s.maxTotalAUD).toBe(DEFAULT_SETTINGS.maxTotalAUD);
  });
  it('validates and persists via putSettings', async () => {
    const next = await putSettings({ quantity: 3, maxTotalAUD: '750.50' } as Partial<DukeSettings>);
    expect(next.quantity).toBe(3);
    expect(next.maxTotalAUD).toBe('750.50');
    expect(mem.dukeSettings).toMatchObject({ quantity: 3 });
  });
  it('rejects invalid values', async () => {
    await expect(putSettings({ quantity: 0 })).rejects.toThrow();
    await expect(putSettings({ maxTotalAUD: '-5' })).rejects.toThrow();
  });
  it('falls back to defaults when stored settings are corrupt', async () => {
    mem.dukeSettings = { quantity: 999 };
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
  it('accepts boundary values', async () => {
    await expect(putSettings({ quantity: 20, maxTotalAUD: '50000' })).resolves.toBeDefined();
    await expect(putSettings({ quantity: 21 })).rejects.toThrow();
    await expect(putSettings({ maxTotalAUD: '99999.99' })).rejects.toThrow();
  });
});

describe('profile + history storage', () => {
  beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });
  it('stores and returns the profile', async () => {
    const profile: DukeProfileRecord = { name: 'Home', firstName: 'A', lastName: 'B', phone: '0412345678',
      deliveryAddress: { line1: '1 St', line2: '', suburb: 'Clayton', postcode: '3168', state: 'VIC', country: 'AU' }, billingSame: true };
    await putProfile(profile);
    expect(await getProfile()).toEqual(profile);
  });
  it('run history is capped at 100 newest-first', async () => {
    for (let i = 0; i < 105; i++) await pushRun({ id: `run-${i}`, status: 'failed' });
    const history = await getHistory();
    expect(history).toHaveLength(100);
    expect(history[0].id).toBe('run-104');
  });
});
