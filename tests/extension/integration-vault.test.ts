// The encrypted card vault is only useful if it actually survives a browser
// restart, which unit tests cannot prove (chrome.storage.session is wiped and
// IndexedDB is a real-browser store). This launches the built extension twice
// against the SAME profile and asks the worker for the card after session
// storage is gone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import type { Browser, Page } from 'puppeteer-core';
import {
  assertExtensionBuilt, findOrOpenAppTab, launchExtensionBrowser, makeTemporaryDir, profile, testCard,
} from './fixture-retailer.ts';

const SETTINGS = {
  quantity: 1, maxTotalAUD: '1000.00', mode: 'purchase' as const,
  confirmBeforePay: false, hoverChip: true, autoArm: false, cardClearAfterOrder: false,
  rememberCardOnDevice: true, inlineBadges: true,
};
const card = { number: testCard.number, expiry: testCard.expiry, cvv: testCard.cvv };

interface CardReply { result?: { card?: { number: string; expiry: string; cvv: string }; source?: 'session' | 'device' } }

let temporary: string;
let first: Browser | null = null;
let second: Browser | null = null;

beforeAll(async () => {
  assertExtensionBuilt();
  temporary = await makeTemporaryDir('duke-vault-integration-');
}, 30_000);

afterAll(async () => {
  await first?.close().catch(() => undefined);
  await second?.close().catch(() => undefined);
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function appPageFor(browser: Browser, extensionId: string): Promise<Page> {
  const page = await findOrOpenAppTab(browser, extensionId);
  await page.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#field-quantity', { timeout: 20_000 });
  return page;
}

describe('encrypted card vault across a browser restart', () => {
  it('restores the card from the device vault with no plaintext at rest', async () => {
    const launched = await launchExtensionBrowser(temporary);
    first = launched.browser;
    const page = await appPageFor(first, launched.extensionId);

    const seeded = await page.evaluate(async (seed) => {
      await chrome.storage.local.set({ dukeSettings: seed.settings, dukeProfile: seed.profile });
      const saved = await chrome.runtime.sendMessage({ id: crypto.randomUUID(), type: 'card.save', payload: { card: seed.card, persist: true } });
      const vault = (await chrome.storage.local.get(['dukeCardVault'])).dukeCardVault;
      await chrome.runtime.sendMessage({ id: crypto.randomUUID(), type: 'card.session.clear', payload: null });
      const resolved = await chrome.runtime.sendMessage({ id: crypto.randomUUID(), type: 'card.get', payload: null });
      return { saved: saved?.result, vault: JSON.stringify(vault ?? {}), resolved };
    }, { settings: SETTINGS, profile, card });

    expect(seeded.saved).toMatchObject({ persisted: true, source: 'device' });
    // The on-disk envelope must not contain the PAN or the security code.
    expect(seeded.vault).not.toContain(card.number);
    expect(seeded.vault).not.toContain(card.cvv);
    // Session storage is empty, so this came from the vault.
    expect((seeded.resolved as CardReply).result).toMatchObject({ source: 'device', card });

    await first.close();
    first = null;

    const relaunched = await launchExtensionBrowser(temporary);
    second = relaunched.browser;
    const restarted = await appPageFor(second, relaunched.extensionId);
    const restored = await restarted.evaluate(async () => {
      const resolved = await chrome.runtime.sendMessage({ id: crypto.randomUUID(), type: 'card.get', payload: null });
      const status = await chrome.runtime.sendMessage({ id: crypto.randomUUID(), type: 'card.status', payload: null });
      const session = await chrome.storage.session.get(['dukeCard']);
      return { resolved, status: status?.result, session: session.dukeCard ?? null };
    });

    expect(restored.session).toBeNull();
    expect((restored.resolved as CardReply).result).toMatchObject({ source: 'device', card });
    expect(restored.status).toMatchObject({ session: false, device: true, vaultAvailable: true });
  }, 120_000);
});
