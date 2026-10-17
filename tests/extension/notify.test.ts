import { beforeEach, describe, expect, it } from 'vitest';
import { notificationFor, notifyOutcome, createNotifier, registerNotifications, NOTIFICATION_ICON } from '../../src/extension/background/notify.ts';
import type { CheckoutRun, RunStatus } from '../../src/shared/types.ts';

const created: Array<{ id: string; options: Record<string, unknown> }> = [];
const clickHandlers: Array<() => void> = [];
const openedTabs: string[] = [];

// notify.ts pulls triggers.ts for openAppPage; neither touches chrome at module
// evaluation, so this stub can be installed after the imports (same as
// triggers.test.ts).
(globalThis as Record<string, unknown>).chrome = {
  notifications: {
    create: async (id: string, options: Record<string, unknown>) => { created.push({ id, options }); return id; },
    onClicked: { addListener: (handler: () => void) => { clickHandlers.push(handler); } },
  },
  runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, getContexts: async () => [] },
  tabs: {
    query: async () => [],
    create: async (options: { url: string }) => { openedTabs.push(options.url); return { id: 1 }; },
    update: async () => undefined,
  },
};

type Copy = { status: RunStatus; mode: CheckoutRun['mode']; orderNumber?: string; error?: { code: string; message: string } };
const copy = (status: RunStatus, patch: Partial<Copy> = {}): Copy => ({ status, mode: 'purchase', ...patch });

describe('notificationFor', () => {
  it('maps a successful run to its order reference', () => {
    expect(notificationFor(copy('succeeded', { orderNumber: 'BW-77' }))?.message).toBe('Order placed. Reference BW-77.');
  });

  it('uses the run error for a failure and falls back when there is none', () => {
    expect(notificationFor(copy('failed', { error: { code: 'PAYMENT_DECLINED', message: 'Card declined.' } }))?.message).toBe('Card declined.');
    expect(notificationFor(copy('failed'))?.message).toBe('The order was not placed.');
  });

  it('maps the unknown-outcome and authentication statuses to their prompts', () => {
    expect(notificationFor(copy('payment_unknown'))?.message).toBe('Check BIG W orders — the payment outcome is not confirmed.');
    expect(notificationFor(copy('action_required'))?.message).toBe('Your bank needs authentication — complete it in the BIG W tab.');
  });

  it('maps a ready run by the mode that produced it', () => {
    expect(notificationFor(copy('ready', { mode: 'assist' }))?.message).toBe('Card filled — press Pay in the BIG W tab.');
    expect(notificationFor(copy('ready', { mode: 'prepare' }))?.message).toBe('Checkout is ready in the BIG W tab.');
    expect(notificationFor(copy('ready', { mode: 'afterpay' }))?.message).toBe('Afterpay is open in the BIG W tab.');
  });

  it('stays silent for in-flight and cancelled runs', () => {
    for (const status of ['queued', 'running', 'cancelled'] as RunStatus[]) expect(notificationFor(copy(status))).toBeNull();
  });
});

describe('NOTIFICATION_ICON', () => {
  it('is a 128x128 PNG data URL', () => {
    expect(NOTIFICATION_ICON.startsWith('data:image/png;base64,')).toBe(true);
    const bytes = Buffer.from(NOTIFICATION_ICON.replace(/^data:image\/png;base64,/, ''), 'base64');
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(bytes.readUInt32BE(16)).toBe(128);
    expect(bytes.readUInt32BE(20)).toBe(128);
  });
});

describe('notifyOutcome', () => {
  beforeEach(() => { created.length = 0; });

  it('creates a basic notification with a stable id and the shared icon', () => {
    notifyOutcome({ id: 'abc', status: 'succeeded', mode: 'purchase', orderNumber: 'BW-1' });
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe('duke-abc');
    expect(created[0].options).toMatchObject({ type: 'basic', iconUrl: NOTIFICATION_ICON, requireInteraction: false });
  });

  it('does nothing for a non-notifiable run', () => {
    notifyOutcome({ id: 'abc', status: 'running', mode: 'purchase' });
    expect(created).toHaveLength(0);
  });
});

describe('createNotifier', () => {
  it('sends one notification per run status', () => {
    const sent: string[] = [];
    const notify = createNotifier(run => sent.push(`${run.id}:${run.status}`));
    const run: Copy & { id: string } = { id: 'r1', status: 'action_required', mode: 'purchase' };
    notify(run);
    notify(run);
    notify({ ...run, status: 'succeeded', orderNumber: 'BW-9' });
    expect(sent).toEqual(['r1:action_required', 'r1:succeeded']);
  });

  it('ignores non-notifiable updates', () => {
    const sent: string[] = [];
    const notify = createNotifier(run => sent.push(run.id));
    notify({ id: 'r1', status: 'running', mode: 'purchase' });
    expect(sent).toEqual([]);
  });
});

describe('registerNotifications', () => {
  it('composes the manager update hook and focuses the app page on click', async () => {
    created.length = 0; clickHandlers.length = 0; openedTabs.length = 0;
    const updates: string[] = [];
    const hook = registerNotifications(run => updates.push(run.id));
    const run = { id: 'r9', status: 'succeeded', mode: 'purchase', orderNumber: 'BW-9' } as CheckoutRun;
    hook(run);
    hook(run);
    // The badge mapping sees every update; the notification is deduped to one.
    expect(updates).toEqual(['r9', 'r9']);
    expect(created.filter(item => item.id === 'duke-r9')).toHaveLength(1);
    expect(clickHandlers).toHaveLength(1);
    clickHandlers[0]();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(openedTabs).toEqual(['chrome-extension://test/app.html']);
  });
});
