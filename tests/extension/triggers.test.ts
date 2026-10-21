import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  triggerPlan, shouldAutoArm,
  setLastHovered, getLastHovered, clearLastHovered,
  scheduleAutoArm, AUTO_ARM_DEBOUNCE_MS,
  claimAutoArmSlot, resetAutoArmSlots, AUTO_ARM_MIN_INTERVAL_MS,
  configureTriggers, dispatchTrigger, clampQuantity,
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
const createdTabs: Array<Record<string, unknown>> = [];

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
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    getContexts: async () => [],
  },
  tabs: {
    TAB_ID_NONE: -1,
    query: async () => [],
    create: async (options: Record<string, unknown>) => { createdTabs.push(options); return { id: 1 }; },
    update: async () => ({}),
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

describe('auto-arm global interval', () => {
  afterEach(() => { resetAutoArmSlots(); vi.useRealTimers(); });

  it('allows at most one auto-arm per interval across all tabs', () => {
    resetAutoArmSlots();
    const t0 = 1_000_000;
    expect(claimAutoArmSlot(t0)).toBe(true);
    expect(claimAutoArmSlot(t0 + AUTO_ARM_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(claimAutoArmSlot(t0 + AUTO_ARM_MIN_INTERVAL_MS)).toBe(true);
    expect(claimAutoArmSlot(t0 + AUTO_ARM_MIN_INTERVAL_MS * 2 - 1)).toBe(false);
  });

  it('defaults to the wall clock', () => {
    vi.useFakeTimers();
    resetAutoArmSlots();
    vi.setSystemTime(5_000_000);
    expect(claimAutoArmSlot()).toBe(true);
    expect(claimAutoArmSlot()).toBe(false);
    vi.setSystemTime(5_000_000 + AUTO_ARM_MIN_INTERVAL_MS);
    expect(claimAutoArmSlot()).toBe(true);
  });
});

describe('dispatchTrigger app routing', () => {
  const profileRecord = {
    name: 'Home delivery', firstName: 'Ada', lastName: 'Lovelace', phone: '+61412345678',
    deliveryAddress: { line1: '1 Example St', line2: '', suburb: 'Sydney', postcode: '2000', state: 'NSW', country: 'AU' },
    billingSame: true,
  };

  beforeEach(() => {
    local.clear();
    session.clear();
    createdTabs.length = 0;
    resetAutoArmSlots();
    configureTriggers({ adapter: { arm: vi.fn() }, manager: { start: vi.fn() } });
  });

  it('never opens the app page when a card-mode has no card (notifies instead)', async () => {
    local.set('dukeSettings', settings({ mode: 'purchase', confirmBeforePay: false }));
    local.set('dukeProfile', profileRecord);
    const result = await dispatchTrigger('checkout', PRODUCT, 1);
    expect(result).toMatchObject({ ok: false, code: 'CARD_REQUIRED' });
    expect(createdTabs).toEqual([]);
  });

  it('passes the chip quantity and its presentation tab into the run', async () => {
    local.set('dukeSettings', settings({ mode: 'purchase', confirmBeforePay: false }));
    local.set('dukeProfile', profileRecord);
    session.set('dukeCard', { number: '4111111111111111', expiry: '12/37', cvv: '123' });
    const start = vi.fn(async (_payload: Record<string, unknown>) => ({ id: 'run-1' }));
    const setPresentationTab = vi.fn();
    const openProgress = vi.fn(async () => 77);
    let saved: DukeSettings | null = null;
    configureTriggers({
      adapter: { arm: vi.fn(), setPresentationTab },
      manager: { start },
      openProgress,
      notifySettings: next => { saved = next; },
    });
    const result = await dispatchTrigger('checkout', PRODUCT, 1, { quantity: 3 });
    expect(result).toMatchObject({ ok: true, runId: 'run-1' });
    expect(openProgress).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ quantity: 3, productUrl: PRODUCT }));
    const payload = start.mock.calls[0][0] as { requestId: string };
    expect(setPresentationTab).toHaveBeenCalledWith(77, payload.requestId);
    await vi.waitFor(() => expect(saved).toMatchObject({ quantity: 3 }));
  });

  it('clamps chip quantities to the settings range', () => {
    expect(clampQuantity(-5)).toBe(1);
    expect(clampQuantity(0)).toBe(1);
    expect(clampQuantity(3)).toBe(3);
    expect(clampQuantity(99)).toBe(20);
    expect(clampQuantity('4')).toBe(4);
    expect(clampQuantity('nope', 7)).toBe(7);
    expect(clampQuantity(undefined, 2)).toBe(2);
  });

  it('runs confirm-before-pay as a fill-only review in the checkout tab (no app page)', async () => {
    local.set('dukeSettings', settings({ mode: 'purchase', confirmBeforePay: true }));
    local.set('dukeProfile', profileRecord);
    session.set('dukeCard', { number: '4111111111111111', expiry: '12/37', cvv: '123' });
    const start = vi.fn();
    configureTriggers({ adapter: { arm: vi.fn() }, manager: { start } });
    await dispatchTrigger('checkout', PRODUCT, 1);
    expect(createdTabs).toEqual([]);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: 'assist', productUrl: PRODUCT }));
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
