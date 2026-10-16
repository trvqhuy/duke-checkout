# Duke Checkout Extension — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an installable MV3 Chrome extension (`dist-extension/`) that reuses the existing BIG W "brain" for settings, product inspection, and arm/standby preparation over native content-script messaging — no Node server, no CDP.

**Architecture:** Service worker owns state + message routing; a MAIN-world content script on bigw.com.au performs token resolution and API fetches (port of `PAGE_REQUEST`/`PAGE_CONTEXT`); an ISOLATED-world relay bridges SW ↔ main world; the React client ports to an extension page over `chrome.runtime` messaging. Payment page driving is Stage 2; triggers are Stage 3; CRX packaging is Stage 4.

**Tech Stack:** TypeScript, Vite (multi-entry extension build), React (existing client), chrome.storage/chrome.runtime/chrome.tabs/chrome.alarms, vitest + puppeteer-core (existing harness).

**Spec:** `docs/superpowers/specs/2026-10-16-duke-extension-design.md`
**Later stages:** ② RunManager + checkout-driver + payment, ③ link-scout/context-menu/shortcut/auto-arm/onboarding polish, ④ CRX + update.xml release pipeline.

**Repo note:** the project directory is **not a git repo yet** — Task 1 initializes git. Every task ends with a commit; approving this plan approves those commits (local only, no remote).

---

### Task 1: Repo init + extension scaffold that builds

**Files:**
- Create: `src/extension/manifest.json`
- Create: `src/extension/background/service-worker.ts`
- Create: `src/extension/content/api-bridge-main.ts` (stub, Task 5 fills it)
- Create: `src/extension/content/api-bridge-isolated.ts` (stub, Task 6 fills it)
- Create: `src/extension/content/link-scout.ts` (stub, Stage 3 fills it)
- Create: `src/extension/app/app.html`
- Create: `vite.extension.config.ts`
- Modify: `package.json` (scripts), `.gitignore`

- [ ] **Step 1: Initialize git**

```bash
cd /home/huyvtrinh/code/MrDuke/pokemon-bot
git init -b main
git add -A && git commit -m "chore: snapshot local checkout app before extension stage 1"
```

- [ ] **Step 2: Create `src/extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Duke Checkout",
  "version": "0.1.0",
  "description": "Prepared, guarded BIG W checkout. Local execution only.",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "alarms", "tabs", "contextMenus", "notifications"],
  "host_permissions": [
    "https://www.bigw.com.au/*",
    "https://api.bigw.com.au/*",
    "https://apix.bigw.com.au/*",
    "https://secure-fields.wpay2.gr4vy.app/*",
    "https://portal.afterpay.com/*"
  ],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "Duke Checkout", "default_popup": "app.html?popup=1" },
  "options_page": "app.html",
  "content_scripts": [
    { "matches": ["https://www.bigw.com.au/*"], "js": ["content/api-bridge-main.js"], "run_at": "document_start", "world": "MAIN" },
    { "matches": ["https://www.bigw.com.au/*"], "js": ["content/api-bridge-isolated.js"], "run_at": "document_start", "world": "ISOLATED" },
    { "matches": ["<all_urls>"], "js": ["content/link-scout.js"], "run_at": "document_idle" }
  ]
}
```

- [ ] **Step 3: Create stub entries**

`src/extension/background/service-worker.ts`:
```ts
chrome.runtime.onInstalled.addListener(() => { console.log('[duke] installed'); });
```

`src/extension/content/api-bridge-main.ts`:
```ts
export {};
```

`src/extension/content/api-bridge-isolated.ts`:
```ts
export {};
```

`src/extension/content/link-scout.ts`:
```ts
export {};
```

`src/extension/app/app.html`:
```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Duke Checkout</title></head>
<body><div id="root"></div><script type="module" src="./main.tsx"></script></body>
</html>
```

- [ ] **Step 4: Create `vite.extension.config.ts`**

```ts
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';

export default defineConfig({
  build: {
    outDir: 'dist-extension',
    emptyOutDir: true,
    target: 'chrome116',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/extension/background/service-worker.ts'),
        'api-bridge-main': resolve(__dirname, 'src/extension/content/api-bridge-main.ts'),
        'api-bridge-isolated': resolve(__dirname, 'src/extension/content/api-bridge-isolated.ts'),
        'link-scout': resolve(__dirname, 'src/extension/content/link-scout.ts'),
        app: resolve(__dirname, 'src/extension/app/app.html'),
      },
      output: {
        entryFileNames: chunk => chunk.name === 'background' ? 'background.js' : 'content/[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: chunk => chunk.name?.startsWith('app') ? '[name][extname]' : 'assets/[name][extname]',
      },
    },
  },
  plugins: [{
    name: 'duke-manifest',
    closeBundle() {
      copyFileSync('src/extension/manifest.json', 'dist-extension/manifest.json');
      mkdirSync('dist-extension/content', { recursive: true });
    },
  }],
});
```

- [ ] **Step 5: Wire scripts + gitignore**

Add to `package.json` scripts:
```json
"build:ext": "vite build -c vite.extension.config.ts"
```
Add to `.gitignore`:
```
dist-extension/
*.crx
*.pem
```

- [ ] **Step 6: Build and verify layout**

Run: `npm run build:ext`
Expected: `dist-extension/` contains `manifest.json`, `background.js`, `content/api-bridge-main.js`, `content/api-bridge-isolated.js`, `content/link-scout.js`, `app.html` + app assets. If Rollup renames content entries unexpectedly, adjust `entryFileNames` until the paths match the manifest exactly.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(ext): MV3 scaffold with multi-entry vite build"
```

---

### Task 2: Message protocol (typed, shared, tested)

**Files:**
- Create: `src/extension/lib/protocol.ts`
- Test: `tests/extension/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { encodeRequest, decodeRequest, encodeResponse, decodeResponse, isEvent } from '../src/extension/lib/protocol.ts';

describe('extension message protocol', () => {
  it('round-trips a request', () => {
    const raw = encodeRequest({ id: 'r1', type: 'settings.get', payload: null });
    expect(decodeRequest(raw)).toEqual({ id: 'r1', type: 'settings.get', payload: null });
  });
  it('round-trips a response', () => {
    const raw = encodeResponse({ id: 'r1', ok: true, result: { quantity: 1 } });
    expect(decodeResponse(raw)).toEqual({ id: 'r1', ok: true, result: { quantity: 1 } });
    const err = encodeResponse({ id: 'r2', ok: false, error: { code: 'BUDGET', message: 'too high' } });
    expect(decodeResponse(err)).toEqual({ id: 'r2', ok: false, error: { code: 'BUDGET', message: 'too high' } });
  });
  it('rejects malformed requests', () => {
    expect(decodeRequest({ nope: 1 })).toBeNull();
    expect(decodeRequest('string')).toBeNull();
  });
  it('recognizes events only', () => {
    expect(isEvent({ type: 'run.update', payload: {} })).toBe(true);
    expect(isEvent({ type: 'nope' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/protocol.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/extension/lib/protocol.ts`**

```ts
export type RequestType =
  | 'bootstrap.get' | 'settings.get' | 'settings.put'
  | 'profile.get' | 'profile.put' | 'cards.list'
  | 'inspect.start' | 'arm.start' | 'arm.clear' | 'arm.get'
  | 'run.start' | 'run.list' | 'run.cancel' | 'run.resolve';

export interface DukeRequest { id: string; type: RequestType; payload: unknown }
export interface DukeError { code: string; message: string; fields?: Record<string, string> }
export interface DukeResponse { id: string; ok: boolean; result?: unknown; error?: DukeError }
export type DukeEventType = 'run.update' | 'arm.update' | 'notice';
export interface DukeEvent { type: DukeEventType; payload: unknown }

const REQUEST_TYPES: RequestType[] = ['bootstrap.get', 'settings.get', 'settings.put', 'profile.get', 'profile.put', 'cards.list', 'inspect.start', 'arm.start', 'arm.clear', 'arm.get', 'run.start', 'run.list', 'run.cancel', 'run.resolve'];

export function encodeRequest(request: DukeRequest): unknown { return request; }
export function decodeRequest(value: unknown): DukeRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !REQUEST_TYPES.includes(v.type as RequestType)) return null;
  return { id: v.id, type: v.type as RequestType, payload: 'payload' in v ? v.payload : null };
}
export function encodeResponse(response: DukeResponse): unknown { return response; }
export function decodeResponse(value: unknown): DukeResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.ok !== 'boolean') return null;
  return v as unknown as DukeResponse;
}
export function isEvent(value: unknown): value is DukeEvent {
  return typeof value === 'object' && value !== null && ['run.update', 'arm.update', 'notice'].includes((value as DukeEvent).type);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/protocol.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ext): typed message protocol"
```

---

### Task 3: Storage lib — settings with defaults (TDD)

**Files:**
- Create: `src/extension/lib/storage.ts`
- Test: `tests/extension/storage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { getSettings, putSettings, DEFAULT_SETTINGS, type DukeSettings } from '../src/extension/lib/storage.ts';

const mem: Record<string, unknown> = {};
const chromeStub = { storage: { local: {
  get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in mem).map(k => [k, mem[k]])),
  set: async (items: Record<string, unknown>) => { Object.assign(mem, items); },
} } };
(globalThis as Record<string, unknown>).chrome = chromeStub;

describe('settings storage', () => {
  beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });
  it('returns full defaults when nothing stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
  it('merges partial stored settings over defaults', async () => {
    mem.dukeSettings = { quantity: 2 };
    const s = await getSettings();
    expect(s.quantity).toBe(2);
    expect(s.maxTotalAUD).toBe(DEFAULT_SETTINGS.maxTotalAUD);
  });
  it('validates and persists via putSettings', async () => {
    const next = await putSettings({ quantity: 3, maxTotalAUD: '750.50' } as Partial<DukeSettings>);
    expect(next.quantity).toBe(3);
    expect(next.maxTotalAUD).toBe('750.50');
    expect(mem.dukeSettings).toMatchObject({ quantity: 3 });
  });
  it('rejects invalid values', async () => {
    await expect(putSettings({ quantity: 0 })).rejects.toThrow();
    await expect(putSettings({ maxTotalAUD: '-5' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/storage.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/extension/lib/storage.ts`**

```ts
import { z } from 'zod';

export interface DukeSettings {
  quantity: number; maxTotalAUD: string; mode: 'prepare' | 'assist' | 'purchase' | 'afterpay';
  confirmBeforePay: boolean; hoverChip: boolean; autoArm: boolean; cardClearAfterOrder: boolean;
}
export const DEFAULT_SETTINGS: DukeSettings = {
  quantity: 1, maxTotalAUD: '1000.00', mode: 'purchase',
  confirmBeforePay: false, hoverChip: true, autoArm: true, cardClearAfterOrder: false,
};
const settingsSchema = z.object({
  quantity: z.number().int().min(1).max(20),
  maxTotalAUD: z.string().regex(/^\d{1,5}(?:\.\d{1,2})?$/).refine(v => Number(v) > 0 && Number(v) <= 50_000),
  mode: z.enum(['prepare', 'assist', 'purchase', 'afterpay']),
  confirmBeforePay: z.boolean(), hoverChip: z.boolean(), autoArm: z.boolean(), cardClearAfterOrder: z.boolean(),
});
const SETTINGS_KEY = 'dukeSettings';

async function localGet<T>(key: string): Promise<T | undefined> {
  const items = await chrome.storage.local.get([key]);
  return items[key] as T | undefined;
}
async function localSet(key: string, value: unknown): Promise<void> { await chrome.storage.local.set({ [key]: value }); }

export async function getSettings(): Promise<DukeSettings> {
  const merged = { ...DEFAULT_SETTINGS, ...await localGet<Partial<DukeSettings>>(SETTINGS_KEY) };
  return settingsSchema.parse(merged);
}
export async function putSettings(patch: Partial<DukeSettings>): Promise<DukeSettings> {
  const next = settingsSchema.parse({ ...(await getSettings()), ...patch });
  await localSet(SETTINGS_KEY, next);
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/storage.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ext): settings storage with validated defaults"
```

---

### Task 4: Profile + run-history storage

**Files:**
- Modify: `src/extension/lib/storage.ts`
- Test: `tests/extension/storage.test.ts` (append)

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { getProfile, putProfile, getHistory, pushRun, type DukeProfileRecord } from '../src/extension/lib/storage.ts';

describe('profile + history storage', () => {
  beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });
  it('stores and returns the profile', async () => {
    const profile: DukeProfileRecord = { name: 'Home', firstName: 'A', lastName: 'B', phone: '0412345678',
      deliveryAddress: { line1: '1 St', line2: '', suburb: 'Clayton', postcode: '3168', state: 'VIC', country: 'AU' }, billingSame: true };
    await putProfile(profile);
    expect(await getProfile()).toEqual(profile);
  });
  it('run history is capped at 100 newest-first', async () => {
    for (let i = 0; i < 105; i++) await pushRun({ id: `run-${i}`, status: 'failed' });
    const history = await getHistory();
    expect(history).toHaveLength(100);
    expect(history[0].id).toBe('run-104');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/storage.test.ts`
Expected: FAIL (exports missing)

- [ ] **Step 3: Implement (append to `storage.ts`)**

```ts
import type { Profile } from '../../shared/types.ts';
export type DukeProfileRecord = Profile;

const PROFILE_KEY = 'dukeProfile';
const HISTORY_KEY = 'dukeHistory';
const HISTORY_CAP = 100;

export async function getProfile(): Promise<Profile | null> { return (await localGet<Profile>(PROFILE_KEY)) ?? null; }
export async function putProfile(profile: Profile): Promise<Profile> { await localSet(PROFILE_KEY, profile); return profile; }

export interface HistoryEntry { id: string; status: string; [key: string]: unknown }
export async function getHistory(): Promise<HistoryEntry[]> { return (await localGet<HistoryEntry[]>(HISTORY_KEY)) ?? []; }
export async function pushRun(run: HistoryEntry): Promise<void> {
  const history = [run, ...(await getHistory())].slice(0, HISTORY_CAP);
  await localSet(HISTORY_KEY, history);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/storage.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ext): profile and capped run-history storage"
```

---

### Task 5: MAIN-world API bridge (port of PAGE_REQUEST / PAGE_CONTEXT)

**Files:**
- Create: `src/extension/content/api-bridge-main.ts` (replace stub)
- Test: `tests/extension/api-bridge-main.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { resolveToken, pageRequest, handleMessage } from '../src/extension/content/api-bridge-main.ts';

const localStorageStub = (data: Record<string, string>) => {
  const store = new Map(Object.entries(data));
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, key: (i: number) => Array.from(store.keys())[i] ?? null, get length() { return store.size; } });
};

describe('api-bridge main world', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('resolves the newest scoped token from the Auth0 SPA cache', () => {
    localStorageStub({
      '@@auth0spajs@@::client1::https://api.bigw.com.au/api::openid profile cart:manage': JSON.stringify({
        expiresAt: 9999999999, body: { access_token: 'tok1', client_id: 'client1', scope: 'openid profile cart:manage' },
      }),
    });
    vi.stubGlobal('document', { cookie: '' });
    expect(resolveToken(['cart:manage'])?.token).toBe('tok1');
    expect(resolveToken(['payment:manage'])).toBeNull();
  });
  it('pageRequest returns ok:false on HTTP 403 with BROWSER_ATTENTION', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    const result = await pageRequest({ origin: 'https://api.bigw.com.au', path: '/storefront/v1/cart/create', method: 'POST', publicRequest: false, token: 't' });
    expect(result).toEqual({ ok: false, status: 403, code: 'BROWSER_ATTENTION' });
  });
  it('handleMessage answers postMessage protocol requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ hello: 1 })));
    vi.stubGlobal('document', { cookie: '' });
    localStorageStub({});
    const replies: unknown[] = [];
    const post = vi.fn((msg: unknown) => replies.push(msg));
    vi.stubGlobal('window', { addEventListener: () => undefined, postMessage: post } as unknown as Window);
    await handleMessage({ channel: 'duke', requestId: 'x', args: { origin: 'https://api.bigw.com.au', path: '/ping', method: 'GET', publicRequest: true } }, post);
    expect(replies[0]).toMatchObject({ channel: 'duke', requestId: 'x', result: { ok: true, status: 200, data: { hello: 1 } } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/api-bridge-main.test.ts`
Expected: FAIL (module empty)

- [ ] **Step 3: Implement the real bridge**

Replace `src/extension/content/api-bridge-main.ts` with the direct port of `src/server/browser/page-api.ts` (same scope-mapping and error codes — do not invent new ones):

```ts
export function resolveToken(requiredScopes: string[]): { token: string; expiresAt: number; scopes: string[] } | null {
  let clientHint: string | null = null;
  const authCookies = (document.cookie || '').split('; ').filter(v => /^auth0\.[^.]+\.is\.authenticated=/.test(v));
  if (authCookies.length === 1) clientHint = authCookies[0].split('.')[1];
  const candidates: { token: string; expiresAt: number; scopes: string[] }[] = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('@@auth0spajs@@') || !key.includes('::https://api.bigw.com.au/api::') || key.endsWith('@@user@@')) continue;
    try {
      const cached = JSON.parse(localStorage.getItem(key) ?? 'null');
      const client = key.split('::')[1];
      if (!cached?.body?.access_token || (clientHint && client !== clientHint)) continue;
      if (cached.body.client_id && cached.body.client_id !== client) continue;
      const scopes = String(cached.body.scope || key.split('::').slice(3).join('::')).split(/\s+/);
      if (!(requiredScopes || []).every(scope => scopes.includes(scope))) continue;
      candidates.push({ token: cached.body.access_token, expiresAt: Number(cached.expiresAt) || 0, scopes });
    } catch { /* skip malformed cache entries */ }
  }
  candidates.sort((a, b) => b.expiresAt - a.expiresAt || b.scopes.length - a.scopes.length);
  return candidates[0] ?? null;
}

export interface BridgeArgs { origin: string; path: string; method?: string; body?: unknown; publicRequest?: boolean; token?: string; timeoutMs?: number }

export async function pageRequest(args: BridgeArgs): Promise<{ ok: boolean; status: number; data?: unknown; code?: string }> {
  if (!['https://api.bigw.com.au', 'https://apix.bigw.com.au'].includes(args.origin) || !args.path.startsWith('/') || args.path.startsWith('//')) return { ok: false, status: 0, code: 'REQUEST_ORIGIN' };
  const headers: Record<string, string> = { accept: 'application/json' };
  if (args.body !== undefined) headers['content-type'] = 'application/json';
  if (!args.publicRequest) {
    if (!args.token) return { ok: false, status: 401, code: 'LOGIN_REQUIRED' };
    headers[args.path.startsWith('/profile/') ? 'authorization' : 'authorization3'] = `Bearer ${args.token}`;
  }
  try {
    const response = await fetch(args.origin + args.path, {
      method: args.method || 'GET', credentials: args.origin.includes('apix.') ? 'omit' : 'include',
      headers, body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: AbortSignal.timeout(args.timeoutMs || 20000),
    });
    if (!response.ok) return { ok: false, status: response.status, code: response.status === 401 ? 'LOGIN_REQUIRED' : response.status === 403 ? 'BROWSER_ATTENTION' : 'STORE_REQUEST' };
    if (response.status === 204) return { ok: true, status: 204, data: null };
    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, code: (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'REQUEST_NETWORK' };
  }
}

const CHANNEL = 'duke';
export async function handleMessage(message: { channel: string; requestId: string; args: BridgeArgs & { scopes?: string[] } }, post: (msg: unknown) => void): Promise<void> {
  if (message?.channel !== CHANNEL) return;
  const scopes = message.args.publicRequest ? [] : ['cart:view'];
  const token = message.args.token ?? resolveToken(scopes)?.token;
  const result = await pageRequest({ ...message.args, token });
  post({ channel: CHANNEL, requestId: message.requestId, result });
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    void handleMessage(event.data, msg => window.postMessage(msg, '*'));
  });
}
```

Key difference from the server version: the SW resolves the **required scopes per path** and passes them with the request; the main world resolves the token. Adjust `handleMessage` to prefer `args.scopes` (as above, defaulting to `['cart:view']`) — Stage 2 tasks extend the scope map when porting cart mutations.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/api-bridge-main.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ext): MAIN-world api bridge ported from PAGE_REQUEST/PAGE_CONTEXT"
```

---

### Task 6: ISOLATED-world relay + work-tab manager in the SW

**Files:**
- Create: `src/extension/content/api-bridge-isolated.ts` (replace stub)
- Create: `src/extension/background/work-tab.ts`
- Create: `src/extension/background/bridge-client.ts`
- Test: `tests/extension/bridge-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { bridgeRequest } from '../src/extension/background/bridge-client.ts';

function tabStub(respondWith: (msg: unknown) => unknown) {
  return { sendMessage: async (tabId: number, msg: unknown) => respondWith(msg) };
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/bridge-client.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the relay**

`src/extension/content/api-bridge-isolated.ts`:
```ts
const PING = { type: 'bridge.ping' };
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
  if (msg?.type === 'bridge.ping') { sendResponse({ pong: true }); return false; }
  if (msg?.type !== 'bridge.request') return false;
  const requestId = crypto.randomUUID();
  const onReply = (event: MessageEvent) => {
    if (event.source !== window || event.data?.channel !== 'duke' || event.data.requestId !== requestId) return;
    window.removeEventListener('message', onReply);
    sendResponse(event.data.result);
  };
  window.addEventListener('message', onReply);
  window.postMessage({ channel: 'duke', requestId, args: msg.args }, '*');
  return true; // keep the channel open for the async sendResponse
});
export { PING };
```

`src/extension/background/work-tab.ts`:
```ts
const BIG_W_TAB_MATCH = 'https://www.bigw.com.au/*';
const WORK_URL = 'https://www.bigw.com.au/';

export async function acquireWorkTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: BIG_W_TAB_MATCH });
  const checkout = tabs.find(tab => /\/checkout\//.test(tab.url ?? ''));
  const existing = checkout ?? tabs[0];
  if (existing?.id) return existing;
  return chrome.tabs.create({ active: false, url: WORK_URL }) as Promise<chrome.tabs.Tab>;
}

export async function waitForBridgeReady(tabId: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const reply = await chrome.tabs.sendMessage(tabId, { type: 'bridge.ping' }); if (reply?.pong) return; } catch { /* content script not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw Object.assign(new Error('The BIG W page did not accept the bridge. Reload the BIG W tab.'), { code: 'BRIDGE_UNREADY' });
}
```

`src/extension/background/bridge-client.ts`:
```ts
import { AppError } from '../../server/errors.ts';

type Sender = { sendMessage: (tabId: number, msg: unknown) => Promise<unknown> };
const MESSAGES: Record<string, string> = {
  LOGIN_REQUIRED: 'BIG W needs you to sign in again in the BIG W tab.',
  SESSION_EXPIRED: 'The BIG W session expired. Open BIG W and prepare again.',
  BROWSER_ATTENTION: 'BIG W needs attention in Chrome. Complete any sign-in or browser check there, then prepare again.',
  REQUEST_TIMEOUT: 'BIG W took too long to respond to this preparation step.',
  REQUEST_NETWORK: 'The browser could not reach BIG W. Check its connection and try again.',
};

export async function bridgeRequest(sender: Sender, tabId: number, args: unknown): Promise<unknown> {
  const result = await sender.sendMessage(tabId, { type: 'bridge.request', args }) as { ok: boolean; status: number; data?: unknown; code?: string } | null;
  if (!result) throw new AppError('BRIDGE_NO_RESPONSE', 'The BIG W page bridge did not respond. Reload the BIG W tab.');
  if (!result.ok) throw new AppError(result.code ?? 'STORE_REQUEST', MESSAGES[result.code ?? ''] ?? `BIG W rejected the request (HTTP ${result.status}). Check the BIG W tab.`, result.status >= 500 ? 502 : 400);
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/bridge-client.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ext): isolated relay, work-tab manager, bridge client with error mapping"
```

---

### Task 7: Retailer adapter boundary + BIG W inspect & arm port

**Files:**
- Create: `src/extension/lib/retailers/types.ts`
- Create: `src/extension/lib/retailers/bigw/adapter.ts`
- Modify: `src/extension/background/work-tab.ts` (scope map helper)
- Test: `tests/extension/bigw-adapter-ext.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { BigWExtensionAdapter } from '../src/extension/lib/retailers/bigw/adapter.ts';
import { productUrl, profile } from '../../fixtures.ts';

const stubSender = (responses: Record<string, unknown>) => ({
  sendMessage: async (_tabId: number, msg: { args: { path: string } }) => {
    const key = msg.args.path.split('?')[0];
    if (!(key in responses)) throw new Error(`unexpected path ${key}`);
    return responses[key];
  },
});

describe('BigWExtensionAdapter', () => {
  it('inspects a product through the bridge and maps price/availability', async () => {
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({
      '/apim/product-price-api/v1/products': { ok: true, status: 200, data: [{ id: 'p', attributes: { name: 'Example Book' } }] },
      '/apim/product-price-api/v1/prices/6071620': { ok: true, status: 200, data: [{ price: { centAmount: 1800, fractionDigits: 2 } }] },
      '/api/availability/v0/product/6071620': { ok: false, status: 0, code: 'REQUEST_NETWORK' },
    }) }));
    const info = await adapter.inspect(productUrl, profile as never);
    expect(info.code).toBe('6071620');
    expect(info.priceCents).toBe(1800);
    expect(info.available).toBe(false);
  });
  it('arm() on an unavailable product downgrades to standby (same rule as the server app)', async () => {
    const adapter = new BigWExtensionAdapter(async () => ({ tabId: 5, sender: stubSender({}) }));
    await adapter.inspect = async () => ({ code: '1', url: productUrl, title: 'X', imageUrl: '', priceCents: 100, deliveryCents: 0, available: false, stockLabel: '', requiresVariant: false } as never);
    const armed = await adapter.arm({ productUrl, quantity: 1, maxTotalCents: 2500, mode: 'purchase', profile: profile as never }, () => undefined, new AbortController().signal);
    expect(armed.level).toBe('standby');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/bigw-adapter-ext.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter port**

`src/extension/lib/retailers/types.ts`:
```ts
import type { ArmedCheckout, PreparedCheckout, ProductInfo, Profile, RunRequest, StageReporter } from '../../../shared/types.ts';

export interface BridgeHandle { tabId: number; sender: { sendMessage: (tabId: number, msg: unknown) => Promise<unknown> } }
export interface RetailerAdapter {
  urlPattern: RegExp;
  inspect(bridge: BridgeHandle, productUrl: string, profile: Profile): Promise<ProductInfo>;
  prepareCart(bridge: BridgeHandle, input: RunRequest, product: ProductInfo, report: StageReporter, signal: AbortSignal): Promise<PreparedCheckout>;
  arm(bridge: BridgeHandle, input: RunRequest, report: StageReporter, signal: AbortSignal): Promise<ArmedCheckout>;
  verify(bridge: BridgeHandle, prepared: PreparedCheckout, input: RunRequest): Promise<import('../../../shared/types.ts').CartState>;
}
```

`src/extension/lib/retailers/bigw/adapter.ts` — port from `src/server/browser/bigw.ts`:
- Copy `parseCartState`/`buildProductInfo` imports from `src/server/browser/bigw-model.ts` **unchanged** (pure functions).
- Re-implement `inspect` and `prepareCart` with `bridgeRequest(handle.sender, handle.tabId, args)` in place of `this.request(...)`; keep the identical endpoints, bodies, stagger (0/120/240 ms), and the STANDBY downgrade codes from the server version (`['UNAVAILABLE','STORE_REQUEST','REQUEST_NETWORK','REQUEST_TIMEOUT','CART_INVALID']`).
- `arm()`: session semantics collapse to "acquire work tab + bridge ready" (no token-renewal navigation — the bridge reads the live token); then inspect → available? prepareCart → level `cart-ready`, else `standbyArm` (same note strings).
- Reuse `armedMatches` from `src/server/checkout.ts` via a shared export — move `armedMatches` into `src/shared/armed.ts` and have both the server and the extension import it (server keeps a re-export so existing tests pass).

Implementation sketch (adapter core; full bodies copied from the server file):

```ts
import { parseProductLink } from '../../../shared/validation.ts';
import { buildProductInfo, parseCartState } from '../../../server/browser/bigw-model.ts';
import { AppError, checkAbort } from '../../../server/errors.ts';
import { bridgeRequest } from '../../../background/bridge-client.ts';
import type { BridgeHandle, RetailerAdapter } from '../types.ts';
import type { ArmedCheckout, PreparedCheckout, ProductInfo, Profile, RunRequest, StageReporter } from '../../../shared/types.ts';

const STANDBY_CODES = ['UNAVAILABLE', 'STORE_REQUEST', 'REQUEST_NETWORK', 'REQUEST_TIMEOUT', 'CART_INVALID'];

export class BigWExtensionAdapter implements RetailerAdapter {
  readonly urlPattern = /https:\/\/www\.bigw\.com\.au\/product\/[^/]+\/p\/(\d+)/;
  constructor(private acquire: () => Promise<BridgeHandle>) {}

  private async req(handle: BridgeHandle, path: string, method = 'GET', body?: unknown, origin = 'https://api.bigw.com.au', publicRequest = false, scopes = ['cart:view']) {
    return bridgeRequest(handle.sender, handle.tabId, { origin, path, method, body, publicRequest, scopes });
  }

  async inspect(handle: BridgeHandle, productUrl: string, profile: Profile): Promise<ProductInfo> {
    const { code, url } = parseProductLink(productUrl);
    const [location, products, prices] = await Promise.all([
      this.req(handle, `/warehouse-customer/v1/postcode/${encodeURIComponent(profile.deliveryAddress.postcode)}?suburb=${encodeURIComponent(profile.deliveryAddress.suburb.toUpperCase())}`, 'GET', undefined, 'https://api.bigw.com.au', true),
      this.req(handle, `/apim/product-price-api/v1/products?productCodes=${code}`, 'GET', undefined, 'https://apix.bigw.com.au', true),
      this.req(handle, `/apim/product-price-api/v1/prices/${code}?state=${profile.deliveryAddress.state}`, 'GET', undefined, 'https://apix.bigw.com.au', true),
    ]);
    let availability: unknown = null;
    try {
      availability = await this.req(handle, `/api/availability/v0/product/${code}?storeId=1&deliveryPostcode=${profile.deliveryAddress.postcode}&deliverySuburb=${profile.deliveryAddress.suburb.toUpperCase()}`, 'GET', undefined, 'https://api.bigw.com.au', true);
    } catch { /* advisory only */ }
    return buildProductInfo(url, products, prices, availability);
  }
  // prepareCart/arm/verify: copy the bodies from src/server/browser/bigw.ts
  // (prepareCart, arm, standbyArm, verify) replacing this.request(...) with
  // this.req(...) and this.livePage()/page.* with handle-agnostic no-ops.
  // The ONLY behavioural differences in Stage 1:
  //   • arm() skips the checkout-page preload (Stage 2 adds it via the driver)
  //   • locationFor() resolves storeId from the postcode endpoint's zones, and
  //     falls back to /api/stores/v0/list, exactly as the server does.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/bigw-adapter-ext.test.ts`
Expected: PASS (2 tests). Then `npx vitest run` — **the whole suite must stay green**, including the server tests (the `armedMatches` move keeps a re-export).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ext): retailer adapter boundary + BIG W inspect/arm port over the bridge"
```

---

### Task 8: Service worker router (bootstrap, settings, inspect, arm)

**Files:**
- Modify: `src/extension/background/service-worker.ts` (replace stub)
- Create: `src/extension/background/state.ts`
- Test: `tests/extension/state.test.ts`

- [ ] **Step 1: Write the failing test for the arm-state holder**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { getArmed, setArmed, clearArmed } from '../src/extension/background/state.ts';

const mem: Record<string, unknown> = {};
(globalThis as Record<string, unknown>).chrome = { storage: { session: {
  get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in mem).map(k => [k, mem[k]])),
  set: async (items: Record<string, unknown>) => { Object.assign(mem, items); },
  remove: async (keys: string[]) => { for (const k of keys) delete mem[k]; },
} } };

describe('armed state', () => {
  beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });
  it('round-trips and clears', async () => {
    expect(await getArmed()).toBeNull();
    const armed = { level: 'standby', cartId: '', productCode: '1' };
    await setArmed(armed as never);
    expect(await getArmed()).toMatchObject({ level: 'standby' });
    await clearArmed();
    expect(await getArmed()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/state.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `state.ts`**

```ts
import type { ArmedCheckout } from '../../shared/types.ts';
const ARMED_KEY = 'dukeArmed';
export async function getArmed(): Promise<ArmedCheckout | null> {
  return (await chrome.storage.session.get([ARMED_KEY]))[ARMED_KEY] ?? null;
}
export async function setArmed(armed: ArmedCheckout): Promise<void> { await chrome.storage.session.set({ [ARMED_KEY]: armed }); }
export async function clearArmed(): Promise<void> { await chrome.storage.session.remove([ARMED_KEY]); }
```

- [ ] **Step 4: Replace the service worker with the router**

```ts
import { decodeRequest, encodeResponse, isEvent, type DukeRequest } from '../lib/protocol.ts';
import { getSettings, putSettings, getProfile, putProfile, getHistory, pushRun, DEFAULT_SETTINGS } from '../lib/storage.ts';
import { acquireWorkTab, waitForBridgeReady } from './work-tab.ts';
import { getArmed, setArmed, clearArmed } from './state.ts';
import { BigWExtensionAdapter } from '../lib/retailers/bigw/adapter.ts';
import { parseProductLink } from '../../shared/validation.ts';
import { AppError, publicError } from '../../server/errors.ts';

const adapter = new BigWExtensionAdapter(async () => {
  const tab = await acquireWorkTab();
  if (!tab.id) throw new AppError('BRIDGE_UNREADY', 'No BIG W tab is available. Open bigw.com.au once.');
  await waitForBridgeReady(tab.id);
  return { tabId: tab.id, sender: { sendMessage: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg as never) } };
});

async function handle(request: DukeRequest): Promise<unknown> {
  switch (request.type) {
    case 'bootstrap.get': return {
      settings: await getSettings(), profile: await getProfile(), history: await getHistory(),
      armed: await getArmed(), defaults: DEFAULT_SETTINGS,
    };
    case 'settings.get': return await getSettings();
    case 'settings.put': return await putSettings(request.payload as never);
    case 'profile.get': return await getProfile();
    case 'profile.put': return await putProfile(request.payload as never);
    case 'inspect.start': {
      const { productUrl, profile } = request.payload as { productUrl: string; profile: never };
      const handle = await adapter.acquirePublic();
      return await adapter.inspect(handle, productUrl, profile);
    }
    case 'arm.start': {
      const input = request.payload as never;
      const handle = await adapter.acquirePublic();
      const armed = await adapter.arm(handle, input, () => undefined, new AbortController().signal);
      await setArmed(armed);
      broadcast({ type: 'arm.update', payload: armed });
      return armed;
    }
    case 'arm.clear': await clearArmed(); broadcast({ type: 'arm.update', payload: null }); return { ok: true };
    case 'arm.get': return await getArmed();
    default: throw new AppError('UNSUPPORTED', 'This build covers settings, inspection, and arming. Checkout runs arrive in stage 2.');
  }
}

function broadcast(event: { type: string; payload: unknown }) {
  if (!isEvent(event)) return;
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const request = decodeRequest(raw);
  if (!request) return false;
  void handle(request)
    .then(result => sendResponse(encodeResponse({ id: request.id, ok: true, result })))
    .catch(error => sendResponse(encodeResponse({ id: request.id, ok: false, error: publicError(error) })));
  return true;
});
```

Also add to `BigWExtensionAdapter` a small public helper used above:
```ts
acquirePublic() { return this.acquire(); }
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run && npm run build:ext`
Expected: all suites PASS; build succeeds with the larger background bundle.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(ext): service worker router with settings, inspect, arm handlers"
```

---

### Task 9: Session keeper via chrome.alarms

**Files:**
- Create: `src/extension/background/keeper.ts`
- Modify: `src/extension/background/service-worker.ts` (register the alarm)
- Modify: `src/extension/manifest.json` (no change needed — `alarms` permission already present)
- Test: `tests/extension/keeper.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { shouldRefresh } from '../src/extension/background/keeper.ts';

describe('keeper decision', () => {
  it('refreshes only when armed and the token is near expiry', () => {
    expect(shouldRefresh({ armed: true, authenticated: true, tokenSecondsRemaining: 100 })).toBe(true);
    expect(shouldRefresh({ armed: true, authenticated: true, tokenSecondsRemaining: 400 })).toBe(false);
    expect(shouldRefresh({ armed: false, authenticated: true, tokenSecondsRemaining: 100 })).toBe(false);
    expect(shouldRefresh({ armed: true, authenticated: false, tokenSecondsRemaining: 0 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/keeper.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `keeper.ts`**

```ts
const REFRESH_THRESHOLD_SECONDS = 240;

export function shouldRefresh(state: { armed: boolean; authenticated: boolean; tokenSecondsRemaining: number }): boolean {
  return state.armed && state.authenticated && state.tokenSecondsRemaining < REFRESH_THRESHOLD_SECONDS;
}

// Alarm callback: reload the work tab so the BIG W page's own SDK renews the
// token (same recovery as the server's keepSessionFresh). If the work tab is
// already a real BIG W page, reloading it keeps armed page warm-up intact.
export async function refreshSession(getBridge: () => Promise<{ tabId: number }>): Promise<void> {
  const { tabId } = await getBridge();
  await chrome.tabs.reload(tabId).catch(() => undefined);
}

export function registerKeeper(getBridge: () => Promise<{ tabId: number }>, readState: () => Promise<{ armed: boolean; authenticated: boolean; tokenSecondsRemaining: number }>): void {
  chrome.alarms.create('duke-keeper', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== 'duke-keeper') return;
    void readState().then(state => (shouldRefresh(state) ? refreshSession(getBridge) : undefined)).catch(() => undefined);
  });
}
```

Wire into `service-worker.ts`:
```ts
import { registerKeeper } from './keeper.ts';
registerKeeper(
  () => adapter.acquirePublic().then(handle => ({ tabId: handle.tabId })),
  async () => {
    const armed = await getArmed();
    const handle = await adapter.acquirePublic().catch(() => null);
    if (!handle) return { armed: false, authenticated: false, tokenSecondsRemaining: 0 };
    const context = await handle.sender.sendMessage(handle.tabId, { type: 'bridge.context' }).catch(() => null) as { authenticated: boolean; tokenSecondsRemaining: number } | null;
    return { armed: !!armed, authenticated: !!context?.authenticated, tokenSecondsRemaining: context?.tokenSecondsRemaining ?? 0 };
  },
);
```
And add a `bridge.context` case to the isolated relay (`api-bridge-isolated.ts`): it posts `{ channel: 'duke', kind: 'context' }` to the MAIN world, and the MAIN-world script — already listening on `window.message` — extends `handleMessage` to branch on `kind`: `'request'` (existing behaviour, default) vs `'context'`, replying `{ channel, requestId, result: pageContextOutput }` where `pageContextOutput` is a direct port of `PAGE_CONTEXT()` (auth token presence, `tokenSecondsRemaining`, cartId, storeId cookie).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/keeper.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ext): alarms-based session keeper for armed state"
```

---

### Task 10: Port the React client onto chrome.runtime transport

**Files:**
- Create: `src/extension/app/transport.ts`
- Create: `src/extension/app/main.tsx`
- Create: `src/extension/app/App.tsx` (stage-1 scope)
- Modify: reuse styles by importing `../client/styles.css`

- [ ] **Step 1: Implement the transport**

```ts
import { decodeResponse, isEvent, type DukeEvent } from '../lib/protocol.ts';

export async function request<T>(type: string, payload?: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(encodeRequest(type, payload));
  const decoded = decodeResponse(response);
  if (!decoded) throw new Error('Unreadable response from the extension background.');
  if (!decoded.ok) throw Object.assign(new Error(decoded.error?.message ?? 'Request failed'), { code: decoded.error?.code, fields: decoded.error?.fields });
  return decoded.result as T;
}
function encodeRequest(type: string, payload: unknown) { return { id: crypto.randomUUID(), type, payload: payload ?? null }; }

export function onEvent(handler: (event: DukeEvent) => void): () => void {
  const listener = (message: unknown) => { if (isEvent(message)) handler(message); };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
```

- [ ] **Step 2: Stage-1 app UI (`App.tsx`)**

Reuse the existing `Field`, `PaymentFields`-free subset, and styles. The stage-1 App renders:
1. **Status card** — "Running inside your Chrome · session is local" (replaces the connection guide)
2. **Settings card** — quantity, max delivered total, mode, toggles (hoverChip, autoArm, confirmBeforePay, cardClearAfterOrder); Save → `settings.put`; live-updates via re-request
3. **Product card** — product URL field + Inspect button (`inspect.start`) + inspection result line (price/availability), and an **Arm checkout** button (`arm.start` with the settings + stored profile) + armed strip when `arm.get`/`arm.update` reports state; **Clear** (`arm.clear`)
4. **Profile card** — fields bound to `profile.put` (import-from-BIG W arrives in Stage 3 onboarding; stage 1 has manual fields pre-seeded from the server-era saved profile if present)
5. **Runs notice** — "Checkout runs arrive in stage 2" placeholder + existing history read-only

Keep the JSX structure and class names from `src/client/App.tsx`/`components.tsx` so the existing stylesheet applies verbatim; import it via `import '../client/styles.css'` from `main.tsx`.

- [ ] **Step 3: Verify the build**

Run: `npm run build:ext`
Expected: `dist-extension/app.html` + bundled JS; no import of Node-only modules (`node:crypto`, `node:fs`) anywhere in `src/extension/**` — if Vite errors on one, move that helper behind a small shared module without Node imports.

- [ ] **Step 4: Manual load check**

Run: `npx puppeteer browsers install chrome@stable` (once, if needed), then open Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `dist-extension/`. Click the Duke icon: the popup renders the stage-1 UI; Settings persist after a browser restart.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ext): React app page on chrome.runtime transport (settings, inspect, arm)"
```

---

### Task 11: Integration smoke test — extension end-to-end inspect + arm

**Files:**
- Create: `tests/extension/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Reuse the launch pattern from `tests/browser-test.ts` (puppeteer-core + fixture Chrome), adding the extension:

```ts
import { describe, expect, it } from 'vitest';
import { launchFixtureChrome } from '../browser-test-launcher.ts'; // extract the existing launch helper if not exported

describe('extension stage-1 integration', () => {
  it('loads, opens the app page, and inspects a stubbed product', async () => {
    const { browser, pages } = await launchFixtureChrome({
      loadExtension: 'dist-extension',
      intercept: { // same interception technique as tests/browser-test.ts for bigw endpoints
        'https://apix.bigw.com.au/apim/product-price-api/v1/products?productCodes=6071620': [{ id: 'p', attributes: { name: 'Example Book' } }],
        'https://apix.bigw.com.au/apim/product-price-api/v1/prices/6071620?state=VIC': [{ price: { centAmount: 1800, fractionDigits: 2 } }],
        'https://api.bigw.com.au/api/availability/v0/product/6071620?*': { notAvailable: true },
        'https://api.bigw.com.au/warehouse-customer/v1/postcode/3168*': [{ state: 'VIC', miraklZone: 'z1' }],
      },
    });
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/app.html`);
    await page.type('#field-productUrl', 'https://www.bigw.com.au/product/example/p/6071620');
    await page.click('.inspect-button');
    await page.waitForSelector('.inspection-result.available');
    const armed = await page.evaluate(() => chrome.storage.session.get(['dukeArmed'])); // after clicking Arm
    expect(armed.dukeArmed).toBeNull(); // fixture product is not available → no arm occurred; inspect UI proven
    await browser.close();
  });
});
```

Notes for the implementer:
- Get `extensionId` from the launched target list (`browser.targets().find(t => t.type() === 'service_worker')` → parse the ID from `t.url()`), and route SW logs to the test output for debugging.
- If the fixture chrome profile needs the Auth0 `localStorage` token for non-public endpoints, seed it via `page.evaluateOnNewDocument` on a bigw tab opened first (the inspect endpoints used here are public; arm's cart endpoints are not — this test intentionally stops at inspect + UI; full arm integration lands in Stage 2 with the token seeding helper).
- Must run headed or `--headless=new` (extensions do not load in old headless).

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/extension/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Full suite + build + commit**

Run: `npx vitest run && npm run check && npm run build && npm run build:ext`
Expected: all green.

```bash
git add -A && git commit -m "test(ext): stage-1 integration smoke (load, app page, inspect)"
```

---

## Stage-1 exit criteria

- `dist-extension/` loads in Chrome via Load-unpacked; popup + options render the stage-1 UI.
- Settings survive browser restarts; profile persists; history is capped.
- Inspect against real BIG W works from the extension (via the user's real session token).
- Arm works for a purchasable product (cart-ready) and downgrades to standby for an unavailable one; armed state shows in the UI.
- Entire vitest suite green (server + extension units + integration); `npm run build` and `npm run build:ext` clean.

## Roadmap (each gets its own plan when reached)

- **Stage 2 — Checkout runs:** RunManager port to the SW (session-storage state machine), checkout-driver content script (ready/fill/submit via Gr4vy iframes + MutationObserver), pay/assist/afterpay, verify+guards before payment, run UI + events.
- **Stage 3 — Triggers & onboarding:** link-scout chip (Checkout now / Arm), context menu, keyboard shortcut, auto-arm on product-page visits (debounced), badge + notifications, first-run onboarding with BIG W profile import.
- **Stage 4 — Distribution:** CRX packing key + `update.xml`, GitHub Releases workflow, release checklist, uninstall-cleanup notes.
