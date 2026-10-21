import { describe, expect, it } from 'vitest';
import { openSealedCard, sealCard, type VaultEnvelope } from '../../src/extension/lib/card-vault.ts';

const card = { number: '4111111111111111', expiry: '12/37', cvv: '123' };

async function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

describe('card vault envelope', () => {
  it('seals a card with no plaintext in the envelope', async () => {
    const envelope = await sealCard(await key(), card);
    expect(envelope.v).toBe(1);
    expect(envelope.iv.length).toBeGreaterThan(0);
    expect(envelope.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(envelope)).not.toContain(card.number);
    expect(JSON.stringify(envelope)).not.toContain(card.cvv);
  });

  it('round-trips the card with the same key', async () => {
    const cryptoKey = await key();
    const envelope = await sealCard(cryptoKey, card);
    expect(await openSealedCard(cryptoKey, envelope)).toEqual(card);
  });

  it('uses a fresh IV so the same card never seals twice identically', async () => {
    const cryptoKey = await key();
    const first = await sealCard(cryptoKey, card);
    const second = await sealCard(cryptoKey, card);
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
  });

  it('rejects a different key and a malformed envelope', async () => {
    const envelope = await sealCard(await key(), card);
    expect(await openSealedCard(await key(), envelope)).toBeNull();
    expect(await openSealedCard(await key(), { v: 1, iv: 'not-base64', data: 'nope' })).toBeNull();
    expect(await openSealedCard(await key(), { v: 2, iv: envelope.iv, data: envelope.data } as unknown as VaultEnvelope)).toBeNull();
  });
});
