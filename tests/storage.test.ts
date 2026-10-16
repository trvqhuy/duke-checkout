import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { LocalStore, sanitizeRun } from '../src/server/storage.ts';
import { profile, testCard } from './fixtures.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('local contact profiles', () => {
  it('saves, reloads, updates, and removes validated profiles privately', async () => {
    const dir = await mkdtemp('/tmp/opencode/duke-storage-'); directories.push(dir);
    const store = new LocalStore(dir);
    const saved = await store.saveProfile(profile);
    expect(saved.id).toBeTruthy();
    expect((await new LocalStore(dir).profiles())[0].phone).toBe('+61412345678');
    await store.saveProfile({ ...saved, name: 'Work delivery' });
    expect((await store.profiles()).map(item => item.name)).toEqual(['Work delivery']);
    expect((await stat(`${dir}/profiles.json`)).mode & 0o777).toBe(0o600);
    await store.deleteProfile(saved.id!);
    expect(await store.profiles()).toEqual([]);
  });

  it('does not permit card data to enter profile storage', async () => {
    const dir = await mkdtemp('/tmp/opencode/duke-storage-'); directories.push(dir);
    const store = new LocalStore(dir);
    await expect(store.saveProfile({ ...profile, card: testCard })).rejects.toThrow();
  });

  it('whitelists public run fields instead of spreading request bodies', async () => {
    const dir = await mkdtemp('/tmp/opencode/duke-storage-'); directories.push(dir);
    const store = new LocalStore(dir);
    const input = { id: 'run', requestId: 'request', mode: 'prepare', status: 'ready', stage: 'complete', productCode: '6071620', productUrl: 'https://www.bigw.com.au/product/book/p/6071620', quantity: 1, maxTotalCents: 2500, profileName: 'Home', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), elapsedMs: 10, events: [], card: testCard, token: 'sensitive-token', profile };
    const clean = sanitizeRun(input);
    await store.saveRuns([clean]);
    const data = await readFile(`${dir}/runs.json`, 'utf8');
    expect(data).not.toContain(testCard.number);
    expect(data).not.toContain('sensitive-token');
    expect(data).not.toContain(profile.deliveryAddress.line1);
    expect((await store.runs())[0].id).toBe('run');
  });

  it('retains unresolved purchases when recent preparation history is trimmed', async () => {
    const dir = await mkdtemp('/tmp/opencode/duke-storage-'); directories.push(dir);
    const store = new LocalStore(dir);
    const now = new Date().toISOString();
    const unresolved = sanitizeRun({ id: 'unresolved', requestId: 'old-purchase', mode: 'purchase', status: 'payment_unknown', stage: 'payment', productCode: '6071620', productUrl: 'https://www.bigw.com.au/product/book/p/6071620', quantity: 1, maxTotalCents: 2500, profileName: 'Home', startedAt: now, updatedAt: now, elapsedMs: 10, paymentSubmittedAt: now, finishedAt: now, events: [] });
    const recent = Array.from({ length: 110 }, (_, index) => sanitizeRun({ ...unresolved, id: `prepare-${index}`, requestId: `prepare-${index}`, mode: 'prepare', status: 'ready', paymentSubmittedAt: undefined }));
    await store.saveRuns([...recent, unresolved]);
    const reloaded = await new LocalStore(dir).runs();
    expect(reloaded.some(run => run.id === unresolved.id)).toBe(true);
    expect(reloaded.filter(run => run.mode === 'prepare')).toHaveLength(100);
  });
});
