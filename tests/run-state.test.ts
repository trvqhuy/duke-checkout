import { describe, expect, it } from 'vitest';
import { mergeRuns, activeRunId } from '../src/client/run-state.ts';
import type { CheckoutRun } from '../src/shared/types.ts';

const run: CheckoutRun = { id: 'run', requestId: 'request', mode: 'prepare', status: 'ready', stage: 'complete', productCode: '6071620', productUrl: 'https://www.bigw.com.au/product/book/p/6071620', quantity: 1, maxTotalCents: 2500, profileName: 'Home', startedAt: '2026-10-15T12:00:00Z', updatedAt: '2026-10-15T12:00:02Z', finishedAt: '2026-10-15T12:00:02Z', elapsedMs: 2000, events: [] };

describe('asynchronous run snapshots', () => {
  it('does not replace an SSE completion with an older queued HTTP response', () => {
    const result = mergeRuns([run], [{ ...run, status: 'queued', stage: 'connect', updatedAt: run.startedAt }]);
    expect(result[0].status).toBe('ready');
    expect(activeRunId(result, run.id)).toBeNull();
  });

  it('accepts a newer resolution and preserves other history', () => {
    const unknown = { ...run, status: 'payment_unknown' as const };
    const result = mergeRuns([unknown, { ...run, id: 'other' }], [{ ...run, status: 'succeeded', updatedAt: '2026-10-15T12:00:05Z', orderNumber: 'BW-100' }]);
    expect(result).toHaveLength(2);
    expect(result.find(item => item.id === run.id)?.status).toBe('succeeded');
  });

  it('keeps the form locked while a confirmed run is still clearing secure fields', () => {
    const clearing = { ...run, status: 'succeeded' as const, finishedAt: undefined };
    expect(activeRunId([clearing], clearing.id)).toBe(clearing.id);
    expect(activeRunId([{ ...clearing, finishedAt: run.finishedAt }], clearing.id)).toBeNull();
  });
});
