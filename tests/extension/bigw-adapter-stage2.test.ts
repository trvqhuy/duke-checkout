import { describe, expect, it, vi } from 'vitest';
import { BigWExtensionAdapter } from '../../src/extension/lib/retailers/bigw/adapter.ts';
import type { BridgeHandle, DriverFrame, DriverHandle, ObservedEntry } from '../../src/extension/lib/retailers/types.ts';
import type { PaymentBinding } from '../../src/shared/payment-check.ts';
import type { PaymentInput, PreparedCheckout } from '../../src/shared/types.ts';
import { productUrl } from '../fixtures.ts';

const FRAMES: DriverFrame[] = [
  { frameId: 11, url: 'https://secure-fields.wpay2.gr4vy.app/input.html?type=number&sessionId=S-1', type: 'number' },
  { frameId: 12, url: 'https://secure-fields.wpay2.gr4vy.app/input.html?type=expiryDate&sessionId=S-1', type: 'expiryDate' },
  { frameId: 13, url: 'https://secure-fields.wpay2.gr4vy.app/input.html?type=securityCode&sessionId=S-1', type: 'securityCode' },
];

const newCard: PaymentInput = { kind: 'new', number: '4111111111111111', expiry: '12/37', cvv: '123' };
const savedCard: PaymentInput = { kind: 'saved', cardId: 'CARD-1', cvv: '321' };

const prepared: PreparedCheckout = {
  cartId: 'CT_1',
  cart: { id: 'CT_1', version: 4, total: 2200, deliveryCost: 0, entries: [{ productCode: '6071620', quantity: 1 }] },
  product: { code: '6071620', url: productUrl, title: 'A book', priceCents: 1800, deliveryCents: 400, available: true, stockLabel: 'Pre-order' },
};

interface DriverOptions {
  url?: string;
  frames?: DriverFrame[];
  ready?: Record<string, unknown>;
  state?: Record<string, unknown>;
  observe?: ObservedEntry[] | (() => ObservedEntry[]);
  fingerprint?: string;
  afterpay?: Record<string, unknown>;
  values?: Record<string, string>;
  wipeReads?: number;
}

function makeDriver(options: DriverOptions = {}) {
  const values: Record<string, string> = { ...(options.values ?? {}) };
  const reads = { count: 0 };
  const calls = {
    top: [] as Array<{ type?: string }>,
    frame: [] as Array<{ frameId: number; message: { type?: string; value?: unknown } }>,
    navigations: [] as string[],
    guardBindings: [] as PaymentBinding[],
    guardDisable: 0,
    observeClear: 0,
    activate: 0,
  };
  const frames = options.frames ?? FRAMES;
  const ready = options.ready ?? { ready: true, hasThreeFields: true, savedCards: false, continueButton: false };
  const driver: DriverHandle = {
    frames: async () => frames,
    sendTop: async (message: unknown) => {
      const typed = message as { type?: string };
      calls.top.push(typed);
      switch (typed.type) {
        case 'driver.ready': return ready;
        case 'driver.state': return options.state ?? { url: 'https://www.bigw.com.au/checkout/delivery', challenge: false, confirmed: false };
        case 'driver.clickPay': return { clicked: true };
        case 'driver.newCardView': return { clicked: true };
        case 'driver.continueToPayment': return { clicked: true };
        case 'driver.clickAfterpay': return options.afterpay ?? { selected: true, clicked: true };
        default: return {};
      }
    },
    sendFrame: async (frameId: number, message: unknown) => {
      const typed = message as { type?: string; value?: unknown };
      calls.frame.push({ frameId, message: typed });
      const type = frames.find(frame => frame.frameId === frameId)?.type ?? '';
      if (typed.type === 'driver.field.set') { values[type] = String(typed.value ?? ''); return { value: values[type] }; }
      if (typed.type === 'driver.field.get') {
        const wiped = reads.count < (options.wipeReads ?? 0);
        reads.count++;
        return { value: wiped ? '' : (values[type] ?? '') };
      }
      if (typed.type === 'driver.field.clear') { values[type] = ''; return { value: '' }; }
      return {};
    },
    navigate: async (url: string) => { calls.navigations.push(url); },
    activate: async () => { calls.activate++; },
    url: async () => options.url ?? 'https://www.bigw.com.au/checkout/delivery',
    observe: async () => ({ entries: typeof options.observe === 'function' ? options.observe() : (options.observe ?? []) }),
    observeClear: async () => { calls.observeClear++; },
    guardEnable: async (binding: PaymentBinding) => { calls.guardBindings.push(binding); },
    guardDisable: async () => { calls.guardDisable++; },
    antiFraud: async () => ({ fingerprint: options.fingerprint ?? 'FP-1' }),
  };
  return { driver, calls };
}

const paymentEntry = (body: unknown, status = 200): ObservedEntry => ({
  url: 'https://api.bigw.com.au/storefront/v1/cart/CT_1/pay', method: 'POST', status, bodyText: JSON.stringify(body),
});

// A sent-but-unanswered payment request, as the MAIN-world observer records it.
const pendingPayment = (): ObservedEntry => ({
  url: 'https://api.bigw.com.au/storefront/v1/cart/CT_1/pay', method: 'POST', status: -1, bodyText: '',
});

function makeSender(responses: Record<string, unknown>, requests: Array<{ path: string; method: string; body: unknown }> = []) {
  return {
    sendMessage: async (_tabId: number, msg: unknown) => {
      const args = (msg as { args: { path: string; method?: string; body?: unknown } }).args;
      const key = args.path.split('?')[0];
      requests.push({ path: key, method: args.method ?? 'GET', body: args.body });
      if (!(key in responses)) throw new Error(`unexpected path ${key}`);
      return responses[key];
    },
  };
}

function setup(options: DriverOptions = {}, responses: Record<string, unknown> = {}, requests: Array<{ path: string; method: string; body: unknown }> = []) {
  const { driver, calls } = makeDriver(options);
  const handle: BridgeHandle = { tabId: 7, sender: makeSender(responses, requests), driver };
  return { adapter: new BigWExtensionAdapter(async () => handle), driver, calls, handle, requests };
}

describe('BigWExtensionAdapter stage 2 — fillCard', () => {
  it('fills each secure field once with the card values', async () => {
    const { adapter, calls } = setup();
    await adapter.fillCard(newCard, { programmaticSubmit: true });
    expect(calls.frame.filter(entry => entry.message.type === 'driver.field.set').map(entry => ({ frameId: entry.frameId, value: entry.message.value }))).toEqual([
      { frameId: 11, value: '4111111111111111' },
      { frameId: 12, value: '12/37' },
      { frameId: 13, value: '123' },
    ]);
  });

  it('re-fills when the checkout wipes the fields on the first pass', async () => {
    const { adapter, calls } = setup({ wipeReads: 3 });
    await adapter.fillCard(newCard, { programmaticSubmit: true });
    expect(calls.top.filter(message => message.type === 'driver.newCardView').length).toBeGreaterThanOrEqual(2);
    expect(calls.frame.filter(entry => entry.message.type === 'driver.field.set').length).toBeGreaterThanOrEqual(6);
  });

  it('raises CARD_FIELDS when the secure fields never appear', async () => {
    vi.useFakeTimers();
    try {
      const { adapter } = setup({ ready: { ready: false, hasThreeFields: false, continueButton: false } });
      const pending = adapter.fillCard(newCard, { programmaticSubmit: true });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'CARD_FIELDS' });
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
});

describe('BigWExtensionAdapter stage 2 — pay', () => {
  it('confirms a new-card payment from the observed merchant response and guards the session', async () => {
    const { adapter, calls } = setup({
      values: { number: '4111111111111111', expiryDate: '12/37', securityCode: '123' },
      observe: [paymentEntry({ data: { orderNumber: 'ORD-9' } })],
    });
    const outcome = await adapter.pay(prepared, newCard, () => {});
    expect(outcome).toEqual({ status: 'confirmed', orderNumber: 'ORD-9' });
    expect(calls.guardBindings[0]).toEqual({ cartId: 'CT_1', cartVersion: 4, totalCents: 2200, kind: 'new', sessionId: 'S-1' });
    expect(calls.observeClear).toBe(1);
  });

  it('treats an observed client-error payment response as declined', async () => {
    const { adapter } = setup({
      values: { number: '4111111111111111', expiryDate: '12/37', securityCode: '123' },
      observe: [paymentEntry({ errorCode: 'INVALID_PAYMENT' }, 409)],
    });
    expect((await adapter.pay(prepared, newCard, () => {})).status).toBe('declined');
  });

  it('fails fast with the vault message when the secure card step rejects', async () => {
    const { adapter } = setup({
      values: { number: '4111111111111111', expiryDate: '12/37', securityCode: '123' },
      observe: [{ url: 'https://api.wpay2.gr4vy.app/checkout/sessions/abc/card-details', method: 'POST', status: 400, bodyText: '{}' }],
    });
    const outcome = await adapter.pay(prepared, newCard, () => {});
    expect(outcome).toMatchObject({ status: 'declined' });
    expect((outcome as { message: string }).message).toContain('secure card step failed');
  });

  it('posts the exact saved-card body through the bridge and confirms the order', async () => {
    const { adapter, requests } = setup(
      { fingerprint: 'FP-9' },
      { '/storefront/v1/cart/CT_1/pay': { ok: true, status: 200, data: { data: { orderNumber: 'ORD-7' } } } },
    );
    const outcome = await adapter.pay(prepared, savedCard, () => {});
    expect(outcome).toEqual({ status: 'confirmed', orderNumber: 'ORD-7' });
    const sent = requests.find(request => request.path === '/storefront/v1/cart/CT_1/pay');
    expect(sent).toEqual({
      path: '/storefront/v1/cart/CT_1/pay', method: 'POST',
      body: {
        cartId: 'CT_1', cartVersion: 4, deviceFingerprint: 'FP-9',
        transactions: { creditCardPaymentStoredInfo: { amountInCents: 2200, securityCode: '321', internalPaymentMethodId: 'CARD-1' } },
      },
    });
  });

  it('blocks a new-card payment when the number frame has no session', async () => {
    const { adapter, calls } = setup({ frames: [] });
    const outcome = await adapter.pay(prepared, newCard, () => {});
    expect(outcome).toMatchObject({ status: 'blocked', code: 'CARD_SESSION' });
    expect(calls.guardBindings).toEqual([]);
  });

  it('disables the guard on the pay success path', async () => {
    const { adapter, calls } = setup({
      values: { number: '4111111111111111', expiryDate: '12/37', securityCode: '123' },
      observe: [paymentEntry({ data: { orderNumber: 'ORD-9' } })],
    });
    expect((await adapter.pay(prepared, newCard, () => {})).status).toBe('confirmed');
    expect(calls.guardDisable).toBe(1);
  });

  it('disables the guard on the vault-failure path', async () => {
    const { adapter, calls } = setup({
      values: { number: '4111111111111111', expiryDate: '12/37', securityCode: '123' },
      observe: [{ url: 'https://api.wpay2.gr4vy.app/checkout/sessions/abc/card-details', method: 'POST', status: 400, bodyText: '{}' }],
    });
    expect((await adapter.pay(prepared, newCard, () => {})).status).toBe('declined');
    expect(calls.guardDisable).toBe(1);
  });

  it('does not disable a guard it never enabled', async () => {
    const { adapter, calls } = setup({ frames: [] });
    expect((await adapter.pay(prepared, newCard, () => {})).status).toBe('blocked');
    expect(calls.guardDisable).toBe(0);
  });

  it('signals a challenge once, then confirms from the checkout state', async () => {
    vi.useFakeTimers();
    try {
      const state: Record<string, unknown> = { url: 'https://www.bigw.com.au/checkout/delivery', challenge: true, confirmed: false };
      const entries: ObservedEntry[] = [];
      const { adapter } = setup({
        values: { number: '4111111111111111', expiryDate: '12/37', securityCode: '123' },
        state,
        observe: () => entries,
      });
      const onActionRequired = vi.fn();
      const pending = adapter.pay(prepared, newCard, onActionRequired);
      await vi.advanceTimersByTimeAsync(700);
      expect(onActionRequired).toHaveBeenCalledTimes(1);
      entries.push(paymentEntry({ status: 'PENDING', orderNumber: 'ORD-P' }));
      state.challenge = false;
      state.confirmed = true;
      state.url = 'https://www.bigw.com.au/checkout/confirmation';
      await vi.advanceTimersByTimeAsync(700);
      await vi.advanceTimersByTimeAsync(700);
      await expect(pending).resolves.toEqual({ status: 'confirmed', orderNumber: 'ORD-P' });
      expect(onActionRequired).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('settles unknown on a status-0 payment entry', async () => {
    const { adapter } = setup({
      values: { number: '4111111111111111', expiryDate: '12/37', securityCode: '123' },
      observe: [paymentEntry({}, 0)],
    });
    expect((await adapter.pay(prepared, newCard, () => {})).status).toBe('unknown');
  });

  it('keeps re-clicking through a silent no-op Pay click until a request is observed', async () => {
    vi.useFakeTimers();
    try {
      const entries: ObservedEntry[] = [];
      const { adapter, calls } = setup({
        values: { number: '4111111111111111', expiryDate: '12/37', securityCode: '123' },
        observe: () => entries,
      });
      const pending = adapter.pay(prepared, newCard, () => {});
      // The first click reports clicked:true but sends nothing (the secure
      // fields were rebuilt): no observer entry appears, so the adapter must not
      // treat the click as sent and must keep retrying.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls.top.filter(message => message.type === 'driver.clickPay').length).toBeGreaterThanOrEqual(2);
      // A later click actually sends the request.
      entries.push(pendingPayment());
      await vi.advanceTimersByTimeAsync(700);
      entries[0].status = 200;
      entries[0].bodyText = JSON.stringify({ data: { orderNumber: 'ORD-2' } });
      await vi.advanceTimersByTimeAsync(700);
      await expect(pending).resolves.toEqual({ status: 'confirmed', orderNumber: 'ORD-2' });
    } finally { vi.useRealTimers(); }
  });

  it('does not settle unknown at the 20 s vault deadline once a payment request is sent', async () => {
    vi.useFakeTimers();
    try {
      const entries: ObservedEntry[] = [];
      const { adapter } = setup({
        values: { number: '4111111111111111', expiryDate: '12/37', securityCode: '123' },
        observe: () => entries,
      });
      let result: string | undefined;
      const pending = adapter.pay(prepared, newCard, () => {}).then(outcome => { result = outcome.status; return outcome; });
      // The Pay click forwards a request; the observer records it as in flight
      // (status -1) — the PaymentGuard.onSent signal — before any response.
      entries.push(pendingPayment());
      await vi.advanceTimersByTimeAsync(20_000);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(result).toBeUndefined();
      // The slow response settles after the deadline; the adapter must use it.
      entries[0].status = 200;
      entries[0].bodyText = JSON.stringify({ data: { orderNumber: 'ORD-LATE' } });
      await vi.advanceTimersByTimeAsync(700);
      await expect(pending).resolves.toEqual({ status: 'confirmed', orderNumber: 'ORD-LATE' });
    } finally { vi.useRealTimers(); }
  });
});

describe('BigWExtensionAdapter stage 2 — revealPrepared', () => {
  it('confirms the mounted checkout on the reuse path without navigating', async () => {
    const { adapter, calls } = setup({ url: 'https://www.bigw.com.au/checkout/delivery' });
    const reports: string[] = [];
    await adapter.revealPrepared(prepared, (_stage, message) => reports.push(message), new AbortController().signal, { reuseMountedPage: true });
    expect(calls.activate).toBe(1);
    expect(calls.navigations).toEqual([]);
    expect(calls.top.some(message => message.type === 'driver.ready')).toBe(true);
    expect(reports[0]).toContain('already open');
  });

  it('navigates, activates, clears any guard, and waits for a fresh checkout', async () => {
    const { adapter, calls } = setup({ url: 'https://www.bigw.com.au/' });
    const reports: string[] = [];
    await adapter.revealPrepared(prepared, (_stage, message) => reports.push(message), new AbortController().signal);
    expect(calls.navigations).toEqual(['https://www.bigw.com.au/checkout/delivery']);
    expect(calls.activate).toBe(1);
    expect(calls.guardDisable).toBe(1);
    expect(reports[0]).toBe('Opening the prepared checkout.');
  });
});

describe('BigWExtensionAdapter stage 2 — clear and afterpay', () => {
  it('clears the three secure fields only after a fill happened', async () => {
    const { adapter, calls } = setup();
    await adapter.fillCard(newCard, { programmaticSubmit: true });
    await adapter.clearSensitiveFields();
    expect(calls.frame.filter(entry => entry.message.type === 'driver.field.clear')).toHaveLength(3);
  });

  it('does not clear untouched fields', async () => {
    const { adapter, calls } = setup();
    await adapter.clearSensitiveFields();
    expect(calls.frame.filter(entry => entry.message.type === 'driver.field.clear')).toHaveLength(0);
  });

  it('starts Afterpay and reports a detected click', async () => {
    const { adapter, calls } = setup({ afterpay: { selected: true, clicked: true } });
    expect(await adapter.startAfterpay()).toBe(true);
    expect(calls.activate).toBe(1);
    expect(calls.top.some(message => message.type === 'driver.clickAfterpay')).toBe(true);
  });
});
