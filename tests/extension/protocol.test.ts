import { describe, expect, it } from 'vitest';
import { encodeRequest, decodeRequest, encodeResponse, decodeResponse, isEvent } from '../../src/extension/lib/protocol.ts';

describe('extension message protocol', () => {
  it('round-trips a request', () => {
    const raw = encodeRequest({ id: 'r1', type: 'settings.get', payload: null });
    expect(decodeRequest(raw)).toEqual({ id: 'r1', type: 'settings.get', payload: null });
  });
  it('round-trips a response', () => {
    const raw = encodeResponse({ id: 'r1', ok: true, result: { quantity: 1 } });
    expect(decodeResponse(raw)).toEqual({ id: 'r1', ok: true, result: { quantity: 1 } });
    const err = encodeResponse({ id: 'r2', ok: false, error: { code: 'BUDGET', message: 'too high' } });
    expect(decodeResponse(err)).toEqual({ id: 'r2', ok: false, error: { code: 'BUDGET', message: 'too high' } });
  });
  it('rejects malformed requests', () => {
    expect(decodeRequest({ nope: 1 })).toBeNull();
    expect(decodeRequest('string')).toBeNull();
  });
  it('recognizes events only', () => {
    expect(isEvent({ type: 'run.update', payload: {} })).toBe(true);
    expect(isEvent({ type: 'nope' })).toBe(false);
  });
});
