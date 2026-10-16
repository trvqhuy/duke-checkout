import { describe, expect, it } from 'vitest';
import { bridgeRequest } from '../../src/extension/background/bridge-client.ts';

function tabStub(respondWith: (msg: unknown) => unknown) {
  return { sendMessage: async (_tabId: number, msg: unknown) => respondWith(msg) };
}

describe('bridge client', () => {
  it('sends bridge.request and unwraps ok results', async () => {
    const sent: unknown[] = [];
    const tab = tabStub(msg => { sent.push(msg); return { ok: true, status: 200, data: { id: 'CT_1' } }; });
    const result = await bridgeRequest(tab as never, 5, { origin: 'https://api.bigw.com.au', path: '/storefront/v1/cart/saved-cards', method: 'GET', publicRequest: false });
    expect(result).toEqual({ id: 'CT_1' });
    expect(sent[0]).toMatchObject({ type: 'bridge.request' });
  });
  it('throws AppError-shaped errors using the retailer error mapping', async () => {
    const tab = tabStub(() => ({ ok: false, status: 403, code: 'BROWSER_ATTENTION' }));
    await expect(bridgeRequest(tab as never, 5, { origin: 'https://api.bigw.com.au', path: '/x', method: 'GET', publicRequest: true }))
      .rejects.toMatchObject({ code: 'BROWSER_ATTENTION' });
  });
  it('maps sendMessage rejections to BRIDGE_NO_RESPONSE', async () => {
    const tab = { sendMessage: async () => { throw new Error('Receiving end does not exist'); } };
    await expect(bridgeRequest(tab as never, 5, { origin: 'https://api.bigw.com.au', path: '/x', method: 'GET', publicRequest: true }))
      .rejects.toMatchObject({ code: 'BRIDGE_NO_RESPONSE' });
  });
  it('times out when the page never replies', async () => {
    const tab = { sendMessage: () => new Promise(() => {}) };
    await expect(bridgeRequest(tab as never, 5, { origin: 'https://api.bigw.com.au', path: '/x', method: 'GET', publicRequest: true }, 50))
      .rejects.toMatchObject({ code: 'BRIDGE_NO_RESPONSE' });
  });
});
