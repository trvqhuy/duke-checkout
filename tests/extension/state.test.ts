import { beforeEach, describe, expect, it } from 'vitest';
import { getArmed, setArmed, clearArmed } from '../../src/extension/background/state.ts';

const mem: Record<string, unknown> = {};
(globalThis as Record<string, unknown>).chrome = { storage: { session: {
  get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in mem).map(k => [k, mem[k]])),
  set: async (items: Record<string, unknown>) => { Object.assign(mem, items); },
  remove: async (keys: string[]) => { for (const k of keys) delete mem[k]; },
} } };

describe('armed state', () => {
  beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });
  it('round-trips and clears', async () => {
    expect(await getArmed()).toBeNull();
    const armed = { level: 'standby', cartId: '', productCode: '1' };
    await setArmed(armed as never);
    expect(await getArmed()).toMatchObject({ level: 'standby' });
    await clearArmed();
    expect(await getArmed()).toBeNull();
  });
});
