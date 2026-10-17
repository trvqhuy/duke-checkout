import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  triggerPlan, shouldAutoArm,
  setLastHovered, getLastHovered, clearLastHovered,
  scheduleAutoArm, AUTO_ARM_DEBOUNCE_MS,
} from '../../src/extension/background/triggers.ts';
import { getSessionCard, putSessionCard, clearSessionCard, DEFAULT_SETTINGS, type DukeSettings } from '../../src/extension/lib/storage.ts';
import { badgeStateForRun, setBadge } from '../../src/extension/background/badge.ts';
import type { ArmedCheckout, CheckoutRun } from '../../src/shared/types.ts';

const PRODUCT = 'https://www.bigw.com.au/product/x/p/6071620';
const OTHER = 'https://www.bigw.com.au/product/y/p/999999';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const badgeTexts: string[] = [];
const badgeColors: string[] = [];

const items = (map: Map<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => map.has(key)).map(key => [key, map.get(key)]));

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (keys: string[]) => items(local, keys),
      set: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) local.set(key, value); },
      remove: async (keys: string[]) => { for (const key of keys) local.delete(key); },
    },
    session: {
      get: async (keys: string[]) => items(session, keys),
      set: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) session.set(key, value); },
      remove: async (keys: string[]) => { for (const key of keys) session.delete(key); },
    },
  },
  action: {
    setBadgeText: (details: { text: string }) => { badgeTexts.push(details.text); },
    setBadgeBackgroundColor: (details: { color: string }) => { badgeColors.push(details.color); },
  },
};

function settings(patch: Partial<DukeSettings> = {}): DukeSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

const armed = (productUrl: string): ArmedCheckout => ({ productUrl } as ArmedCheckout);

describe('triggerPlan truth table', () => {
  it('sends a missing profile to onboarding, even for arm', () => {
    expect(triggerPlan({ settings: settings(), hasProfile: false, hasCard: true }, 'checkout')).toBe('open-onboarding');
    expect(triggerPlan({ settings: settings(), hasProfile: false, hasCard: true }, 'arm')).toBe('open-onboarding');
  });

  it('arms when a profile exists and the action is arm', () => {
    expect(triggerPlan({ settings: settings(), hasProfile: true, hasCard: false }, 'arm')).toBe('arm');
  });

  it('opens the app when confirm-before-pay is on', () => {
    expect(triggerPlan({ settings: settings({ confirmBeforePay: true }), hasProfile: true, hasCard: true }, 'checkout')).toBe('open-app');
    expect(triggerPlan({ settings: settings({ mode: 'prepare', confirmBeforePay: true }), hasProfile: true, hasCard: false }, 'checkout')).toBe('open-app');
  });

  it('opens the app when a card-requiring mode has no card', () => {
    expect(triggerPlan({ settings: settings({ mode: 'assist' }), hasProfile: true, hasCard: false }, 'checkout')).toBe('open-app');
    expect(triggerPlan({ settings: settings({ mode: 'purchase' }), hasProfile: true, hasCard: false }, 'checkout')).toBe('open-app');
  });

  it('starts when a card-requiring mode has a card', () => {
    expect(triggerPlan({ settings: settings({ mode: 'assist' }), hasProfile: true, hasCard: true }, 'checkout')).toBe('start');
    expect(triggerPlan({ settings: settings({ mode: 'purchase' }), hasProfile: true, hasCard: true }, 'checkout')).toBe('start');
  });

  it('starts modes that need no card', () => {
    expect(triggerPlan({ settings: settings({ mode: 'prepare' }), hasProfile: true, hasCard: false }, 'checkout')).toBe('start');
    expect(triggerPlan({ settings: settings({ mode: 'afterpay' }), hasProfile: true, hasCard: false }, 'checkout')).toBe('start');
  });
});

describe('shouldAutoArm', () => {
  it('is false when auto-arm is disabled', () => {
    expect(shouldAutoArm({ autoArm: false }, null, PRODUCT)).toBe(false);
  });

  it('is false for a non-product URL', () => {
    expect(shouldAutoArm({ autoArm: true }, null, 'https://www.bigw.com.au/')).toBe(false);
    expect(shouldAutoArm({ autoArm: true }, null, '')).toBe(false);
  });

  it('is true when nothing is armed', () => {
    expect(shouldAutoArm({ autoArm: true }, null, PRODUCT)).toBe(true);
  });

  it('is true when a different product is armed', () => {
    expect(shouldAutoArm({ autoArm: true }, armed(OTHER), PRODUCT)).toBe(true);
  });

  it('is false when the same product is already armed', () => {
    expect(shouldAutoArm({ autoArm: true }, armed(PRODUCT), PRODUCT)).toBe(false);
  });
});

describe('last-hovered store', () => {
  it('sets, reads, and clears per tab', () => {
    expect(getLastHovered(7)).toBeUndefined();
    setLastHovered(7, PRODUCT);
    setLastHovered(8, OTHER);
    expect(getLastHovered(7)).toBe(PRODUCT);
    expect(getLastHovered(8)).toBe(OTHER);
    clearLastHovered(7);
    expect(getLastHovered(7)).toBeUndefined();
    expect(getLastHovered(8)).toBe(OTHER);
    clearLastHovered(8);
  });
});

describe('auto-arm debounce', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('collapses bursting events for one tab into a single arm', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    scheduleAutoArm(1, run);
    scheduleAutoArm(1, run);
    scheduleAutoArm(1, run);
    vi.advanceTimersByTime(AUTO_ARM_DEBOUNCE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('debounces independently per tab', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    scheduleAutoArm(1, run);
    scheduleAutoArm(2, run);
    vi.advanceTimersByTime(AUTO_ARM_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('session card store', () => {
  it('round-trips and clears, and never touches storage.local', async () => {
    local.clear();
    session.clear();
    const card = { number: '4111111111111111', expiry: '12/30', cvv: '123' };
    await putSessionCard(card);
    expect(await getSessionCard()).toEqual(card);
    expect(session.get('dukeCard')).toEqual(card);
    expect(local.size).toBe(0);
    await clearSessionCard();
    expect(await getSessionCard()).toBeNull();
    expect(session.has('dukeCard')).toBe(false);
  });

  it('ignores malformed stored values', async () => {
    session.clear();
    session.set('dukeCard', { number: '4111' });
    expect(await getSessionCard()).toBeNull();
  });
});

describe('badge', () => {
  it('maps run statuses to badge states', () => {
    const run = (status: CheckoutRun['status']) => ({ status });
    expect(badgeStateForRun(run('queued'))).toBe('running');
    expect(badgeStateForRun(run('running'))).toBe('running');
    expect(badgeStateForRun(run('action_required'))).toBe('attention');
    expect(badgeStateForRun(run('payment_unknown'))).toBe('attention');
    expect(badgeStateForRun(run('succeeded'))).toBe('succeeded');
    expect(badgeStateForRun(run('ready'))).toBe('succeeded');
    expect(badgeStateForRun(run('failed'))).toBe('failed');
    expect(badgeStateForRun(run('cancelled'))).toBe('failed');
  });

  it('writes text and colour for a state', () => {
    badgeTexts.length = 0;
    badgeColors.length = 0;
    setBadge('armed');
    expect(badgeTexts.at(-1)).toBe('a');
    expect(badgeColors.at(-1)).toBe('#188038');
    setBadge('idle');
    expect(badgeTexts.at(-1)).toBe('');
  });
});
