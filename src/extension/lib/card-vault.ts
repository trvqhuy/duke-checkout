// ---------------------------------------------------------------------------
// card-vault — optional at-rest protection for a remembered card
// ---------------------------------------------------------------------------
// The one-run card already lives in chrome.storage.session (memory-only, wiped
// when Chrome closes). Users who want one-click to keep working across browser
// restarts opt into this vault: the card is sealed with AES-GCM under a
// non-extractable device key kept in the extension's IndexedDB. The key cannot
// be exported, so a copy of chrome.storage.local alone does not yield the card.
//
// Honest boundary: anyone who can run code inside this extension (or drive the
// unlocked Chrome profile) can ask the vault to decrypt. This protects the
// value at rest, not against a compromised extension context.
//
// Everything here is chrome-only; importing the module is side-effect free.
// ---------------------------------------------------------------------------
import type { SessionCard } from './storage.ts';

const DB_NAME = 'duke-vault';
const DB_VERSION = 1;
const KEY_STORE = 'keys';
const KEY_ID = 'card-key';
const VAULT_KEY = 'dukeCardVault';
const AAD = 'duke-card-v1';

export interface VaultEnvelope { v: 1; iv: string; data: string }

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isCard(value: unknown): value is SessionCard {
  const card = value as Partial<SessionCard> | null;
  return !!card && typeof card.number === 'string' && typeof card.expiry === 'string' && typeof card.cvv === 'string';
}

// Pure crypto helpers (exported for tests): the envelope carries its own IV, so
// each save is independent and two saves of the same card never produce the
// same ciphertext.
export async function sealCard(key: CryptoKey, card: SessionCard): Promise<VaultEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({ number: card.number, expiry: card.expiry, cvv: card.cvv }));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(AAD) }, key, data);
  return { v: 1, iv: toBase64(iv), data: toBase64(sealed) };
}

export async function openSealedCard(key: CryptoKey, envelope: VaultEnvelope): Promise<SessionCard | null> {
  if (!envelope || envelope.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: new TextEncoder().encode(AAD) },
      key,
      fromBase64(envelope.data),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown;
    return isCard(parsed) ? { number: parsed.number, expiry: parsed.expiry, cvv: parsed.cvv } : null;
  } catch {
    return null;
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(KEY_STORE)) request.result.createObjectStore(KEY_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

function readKey(db: IDBDatabase): Promise<CryptoKey | null> {
  return new Promise(resolve => {
    try {
      const request = db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).get(KEY_ID);
      request.onsuccess = () => resolve(request.result instanceof CryptoKey ? request.result : null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function writeKey(db: IDBDatabase, key: CryptoKey): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const transaction = db.transaction(KEY_STORE, 'readwrite');
      transaction.objectStore(KEY_STORE).put(key, KEY_ID);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
}

function deleteKey(db: IDBDatabase): Promise<void> {
  return new Promise(resolve => {
    try {
      const transaction = db.transaction(KEY_STORE, 'readwrite');
      transaction.objectStore(KEY_STORE).delete(KEY_ID);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch { resolve(); }
  });
}

async function deviceKey(create: boolean): Promise<CryptoKey | null> {
  const db = await openDatabase();
  if (!db) return null;
  try {
    const existing = await readKey(db);
    if (existing || !create) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return (await writeKey(db, key)) ? key : null;
  } finally { db.close(); }
}

export async function vaultAvailable(): Promise<boolean> {
  return (await deviceKey(false)) !== null || typeof indexedDB !== 'undefined';
}

export async function saveDeviceCard(card: SessionCard): Promise<boolean> {
  try {
    const key = await deviceKey(true);
    if (!key) return false;
    await chrome.storage.local.set({ [VAULT_KEY]: await sealCard(key, card) });
    return true;
  } catch {
    return false;
  }
}

export async function loadDeviceCard(): Promise<SessionCard | null> {
  try {
    const stored = (await chrome.storage.local.get([VAULT_KEY]))[VAULT_KEY] as VaultEnvelope | undefined;
    if (!stored) return null;
    const key = await deviceKey(false);
    if (!key) return null;
    const card = await openSealedCard(key, stored);
    // A ciphertext that no longer opens (rotated/cleared key) is dead weight:
    // drop it so the UI never claims a card exists when it cannot be used.
    if (!card) await chrome.storage.local.remove([VAULT_KEY]).catch(() => undefined);
    return card;
  } catch {
    return null;
  }
}

export async function clearDeviceCard(): Promise<void> {
  await chrome.storage.local.remove([VAULT_KEY]).catch(() => undefined);
  const db = await openDatabase();
  if (!db) return;
  try { await deleteKey(db); } finally { db.close(); }
}

export async function hasDeviceCard(): Promise<boolean> {
  try {
    const stored = (await chrome.storage.local.get([VAULT_KEY]))[VAULT_KEY];
    return !!stored;
  } catch { return false; }
}
