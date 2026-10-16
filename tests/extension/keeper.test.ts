import { describe, expect, it } from 'vitest';
import { shouldRefresh } from '../../src/extension/background/keeper.ts';

describe('keeper decision', () => {
  it('refreshes only when armed and the token is near expiry', () => {
    expect(shouldRefresh({ armed: true, authenticated: true, tokenSecondsRemaining: 100 })).toBe(true);
    expect(shouldRefresh({ armed: true, authenticated: true, tokenSecondsRemaining: 400 })).toBe(false);
    expect(shouldRefresh({ armed: false, authenticated: true, tokenSecondsRemaining: 100 })).toBe(false);
    expect(shouldRefresh({ armed: true, authenticated: false, tokenSecondsRemaining: 0 })).toBe(false);
    expect(shouldRefresh({ armed: true, authenticated: true, tokenSecondsRemaining: -5 })).toBe(true);
  });
});
