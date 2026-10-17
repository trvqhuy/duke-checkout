import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driverHandleFor, frameType } from '../../src/extension/background/driver.ts';

interface Sent { tabId: number; message: unknown; options?: { frameId?: number } }

const FRAMES = [
  { frameId: 0, url: 'https://www.bigw.com.au/checkout/delivery' },
  { frameId: 11, url: 'https://secure-fields.wpay2.gr4vy.app/input.html?type=number&sessionId=S-1' },
  { frameId: 12, url: 'https://secure-fields.wpay2.gr4vy.app/input.html?type=expiryDate&sessionId=S-1' },
];

function controlReply(message: unknown): unknown {
  const control = (message as { control?: { kind?: string } }).control;
  switch (control?.kind) {
    case 'observe.list': return { entries: [{ url: 'https://api.bigw.com.au/storefront/v1/cart/CT_1/pay', method: 'POST', status: 200, bodyText: '{}' }] };
    case 'observe.clear': return { ok: true };
    case 'guard.enable': return { ok: true };
    case 'guard.disable': return { ok: true };
    case 'observe.antiFraud': return { fingerprint: 'fp-1' };
    default: return { ok: true };
  }
}

function installChrome(responder?: (message: unknown) => unknown) {
  const sent: Sent[] = [];
  const sendMessage = vi.fn((tabId: number, message: unknown, options?: { frameId?: number }) => {
    sent.push({ tabId, message, options });
    if (responder) return responder(message) as Promise<unknown>;
    if ((message as { type?: string }).type === 'bridge.control') return Promise.resolve(controlReply(message));
    return Promise.resolve({ ok: true });
  });
  const getAllFrames = vi.fn((): Promise<Array<{ frameId: number; url: string }> | null> => Promise.resolve(FRAMES));
  const update = vi.fn(() => Promise.resolve({}));
  const get = vi.fn(() => Promise.resolve({ id: 7, url: 'https://www.bigw.com.au/checkout/delivery' }));
  (globalThis as Record<string, unknown>).chrome = {
    tabs: { sendMessage, update, get },
    webNavigation: { getAllFrames },
  };
  return { sent, sendMessage, getAllFrames, update, get };
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
});

describe('frameType', () => {
  it('reads the Gr4vy input document type query parameter', () => {
    expect(frameType('https://secure-fields.wpay2.gr4vy.app/input.html?type=number&sessionId=S-1')).toBe('number');
    expect(frameType('https://secure-fields.wpay2.gr4vy.app/input.html?type=expiryDate')).toBe('expiryDate');
    expect(frameType('https://secure-fields.wpay2.gr4vy.app/input.html?type=securityCode')).toBe('securityCode');
  });

  it('is undefined for a non-input Gr4vy document', () => {
    expect(frameType('https://secure-fields.wpay2.gr4vy.app/other.html?type=number')).toBeUndefined();
  });

  it('is undefined for a BIG W URL', () => {
    expect(frameType('https://www.bigw.com.au/checkout/delivery?type=number')).toBeUndefined();
  });

  it('is undefined for an invalid URL or a missing type', () => {
    expect(frameType('not a url')).toBeUndefined();
    expect(frameType('https://secure-fields.wpay2.gr4vy.app/input.html')).toBeUndefined();
  });
});

describe('driver handle', () => {
  it('maps getAllFrames into typed driver frames', async () => {
    installChrome();
    const frames = await driverHandleFor(7).frames();
    expect(frames).toEqual([
      { frameId: 0, url: 'https://www.bigw.com.au/checkout/delivery', type: undefined },
      { frameId: 11, url: 'https://secure-fields.wpay2.gr4vy.app/input.html?type=number&sessionId=S-1', type: 'number' },
      { frameId: 12, url: 'https://secure-fields.wpay2.gr4vy.app/input.html?type=expiryDate&sessionId=S-1', type: 'expiryDate' },
    ]);
  });

  it('returns no frames when getAllFrames is null', async () => {
    const { getAllFrames } = installChrome();
    getAllFrames.mockResolvedValueOnce(null);
    expect(await driverHandleFor(7).frames()).toEqual([]);
  });

  it('sendFrame targets a specific frameId; sendTop sends without one', async () => {
    const { sent } = installChrome();
    const driver = driverHandleFor(7);
    await driver.sendFrame(11, { type: 'driver.field.get' });
    await driver.sendTop({ type: 'driver.ready' });
    expect(sent[0]).toEqual({ tabId: 7, message: { type: 'driver.field.get' }, options: { frameId: 11 } });
    expect(sent[1]).toEqual({ tabId: 7, message: { type: 'driver.ready' }, options: undefined });
  });

  it('routes control messages through the relay and unwraps their replies', async () => {
    const { sent } = installChrome();
    const driver = driverHandleFor(7);
    const binding = { cartId: 'CT_1', cartVersion: 4, totalCents: 2200, kind: 'new' as const };

    expect(await driver.observe()).toEqual({ entries: [expect.objectContaining({ method: 'POST', status: 200 })] });
    await driver.observeClear!();
    await driver.guardEnable(binding);
    await driver.guardDisable();
    expect(await driver.antiFraud()).toEqual({ fingerprint: 'fp-1' });

    expect(sent.map(entry => (entry.message as { control?: { kind?: string } }).control?.kind)).toEqual([
      'observe.list', 'observe.clear', 'guard.enable', 'guard.disable', 'observe.antiFraud',
    ]);
    expect(sent[2].message).toEqual({ type: 'bridge.control', control: { kind: 'guard.enable', binding } });
    expect(sent.every(entry => entry.options === undefined)).toBe(true);
  });

  it('drives navigation, activation, and URL through the tab APIs', async () => {
    const { update, get } = installChrome();
    const driver = driverHandleFor(7);
    await driver.navigate('https://www.bigw.com.au/checkout/delivery');
    await driver.activate();
    expect(update).toHaveBeenNthCalledWith(1, 7, { url: 'https://www.bigw.com.au/checkout/delivery' });
    expect(update).toHaveBeenNthCalledWith(2, 7, { active: true });
    expect(await driver.url()).toBe('https://www.bigw.com.au/checkout/delivery');
    expect(get).toHaveBeenCalledWith(7);
  });

  it('maps a sendMessage rejection to a bounded DRIVER_TIMEOUT error', async () => {
    installChrome(() => { throw new Error('Could not establish connection. Receiving end does not exist.'); });
    await expect(driverHandleFor(7).sendTop({ type: 'driver.ready' })).rejects.toMatchObject({ code: 'DRIVER_TIMEOUT' });
  });

  it('times out a never-answering frame driver', async () => {
    installChrome(() => new Promise(() => {}));
    await expect(driverHandleFor(7, 15).sendFrame(11, { type: 'driver.field.get' })).rejects.toMatchObject({ code: 'DRIVER_TIMEOUT' });
  });
});
