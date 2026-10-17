# Duke Checkout Extension — Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Working checkout runs inside the extension: RunManager in the service worker, a checkout-driver content script for the BIG W checkout + Gr4vy frames, a MAIN-world payment guard/observer, and the run UI — so purchase / assist / prepare / afterpay all work with no Node server and no CDP.

**Architecture:** The SW orchestrates runs (`run-manager.ts` ← port of `src/server/checkout.ts`); the `RetailerAdapter` (extended) drives the page through an injected `DriverHandle` capability (chrome.tabs/webNavigation live in the SW, the adapter stays chrome-free); a MAIN-world request guard (`api-bridge-main.ts` extension) enforces the single-submission payment fence because both the page's Pay click and the SW's bridge fetches go through the page's own `fetch`.

**Tech Stack:** existing extension stack + `webNavigation` permission + `jsdom` (devDep, driver unit tests).

**Reference sources (read before porting):** `src/server/checkout.ts` (RunManager), `src/server/browser/payment.ts` (PaymentDriver), `src/server/browser/payment-guard.ts` (guard), `src/server/browser/bigw.ts` (`startAfterpay`, `revealPrepared`, `pay`/`clearSensitiveFields` wiring), `src/client/components.tsx` + `src/client/App.tsx` (run UI).

**Port rule:** keep endpoints, payloads, regexes, thresholds, message strings, and state-machine transitions identical to the server sources unless a task says otherwise. Document every deviation in the file header (same style as `src/extension/lib/retailers/bigw/adapter.ts`).

---

### Task 1: Manifest/build/driver scaffolding

**Files:** Modify `src/extension/manifest.json`, `vite.extension.config.ts`; create `src/extension/content/checkout-driver.ts` (skeleton); modify `package.json` (jsdom devDep).

- [ ] Add `"webNavigation"` to `permissions`.
- [ ] Add content_scripts entries (the driver is a classic IIFE like the bridges):
```json
{ "matches": ["https://www.bigw.com.au/checkout/*"], "js": ["content/checkout-driver.js"], "run_at": "document_idle", "all_frames": true },
{ "matches": ["https://secure-fields.wpay2.gr4vy.app/*"], "js": ["content/checkout-driver.js"], "run_at": "document_idle", "all_frames": true }
```
- [ ] Add `checkout-driver` to the esbuild IIFE content-script list in `vite.extension.config.ts` (same pass as the bridges; target chrome116).
- [ ] `npm i -D jsdom` (driver unit tests run with `// @vitest-environment jsdom`).
- [ ] Skeleton `checkout-driver.ts`: a `chrome.runtime.onMessage` listener + `isFieldFrame()` / `isCheckoutFrame()` helpers + an exported `__test` surface for unit tests (guarded so it does not break the bundle).
- [ ] Verify: `npm run build:ext` emits `content/checkout-driver.js` as IIFE (no `export{`); manifest paths all exist.
- [ ] Commit.

### Task 2: checkout-driver behaviour (top frame + Gr4vy field frames)

**Files:** `src/extension/content/checkout-driver.ts`; test `tests/extension/checkout-driver.test.ts` (jsdom).

**Message protocol** (SW → frame, via `chrome.tabs.sendMessage(tabId, msg, { frameId })`; replies via `sendResponse`):
- Field frames (`secure-fields.wpay2.gr4vy.app/input.html?type=number|expiryDate|securityCode`):
  - `driver.field.get` → `{ value: string }`
  - `driver.field.set` `{ value }` → set via the native value setter + `input`+`change` events, then return `{ value }` read back
  - `driver.field.clear` → reset to `''` with events
- Checkout frame (`www.bigw.com.au/checkout/*`):
  - `driver.ready` → `{ ready: boolean, hasThreeFields: boolean, hasSavedCards: boolean, continueButton: boolean }` where `ready` = three `iframe[src*="secure-fields.wpay2.gr4vy.app/input.html"]` **or** `#saved-cards--nextgen` (same READY condition as `payment.ts:9`), `continueButton` = a button matching `/Continue to Payment/i`
  - `driver.state` → `{ url, challenge, confirmed }` (port of the poll body in `payment.ts` `submit()`: `challenge` = `/3d.?secure|authenticate|challenge/i` on pathname or any iframe src matching `/3ds|challenge/i`; `confirmed` = body text matching `/thank you|order confirmed|order confirmation/i`)
  - `driver.continueToPayment` → click the Continue button if enabled (returns clicked)
  - `driver.newCardView` → port of the fill() snippet: click `input[name="savedOrNewCards"][value="false"]`, else a button matching `/new card/i`
  - `driver.clickPay` → port of the clickPay snippet from `payment.ts` `submit()` (`[data-testid="pay-with-new-card"] form button[type="submit"]` or a button matching `/Pay .* with credit card/i`; click if not disabled; return clicked)
  - `driver.clickAfterpay` → port of the Afterpay selection/click logic from `src/server/browser/bigw.ts` `startAfterpay()` (tabs matching `/afterpay/i`, then the pay button) — return whether a click was performed
  - `driver.clearFields` → no-op at the top frame (clearing happens in the field frames)
  - Rebuild awareness: a `MutationObserver` on the checkout frame watches iframe churn and posts `{ type: 'driver.fieldsChanged' }` to the SW (fire-and-forget `chrome.runtime.sendMessage`) so long waits can react; the SW must tolerate extra messages.
- All handlers must be safe on any frame (check `isFieldFrame()`/`isCheckoutFrame()`; unknown messages return undefined).

**Tests (jsdom):** field-frame `driver.field.set` sets the input value and dispatches input/change; `driver.field.clear` empties it; checkout-frame `driver.ready` true/false against fixture DOM (3 iframes / saved-cards / continue button); `driver.state` challenge/confirmed detection against fixture DOM + `location` stubs (jsdom: use `Object.defineProperty(window, 'location', …)` or set `document.documentElement.innerHTML` variants); `driver.clickPay`/`newCardView`/`continueToPayment` click the right elements.

- [ ] TDD each behaviour → run `npx vitest run tests/extension/checkout-driver.test.ts` → full suite → `npm run build:ext` → commit.

### Task 3: Shared payment-guard core + MAIN-world guard/observer

**Files:** create `src/shared/payment-check.ts`; modify `src/server/browser/payment-guard.ts` (re-export/import the moved pure parts); modify `src/extension/content/api-bridge-main.ts`; tests `tests/extension/payment-check.test.ts`, extend `tests/extension/api-bridge-main.test.ts`.

- [ ] Move the pure pieces of `src/server/browser/payment-guard.ts` to `src/shared/payment-check.ts` **verbatim** (`PaymentBinding`, `financialUrl`, `empty`, `checkPaymentRequest`) and have the server file import + re-export them so `tests/payment-guard.test.ts` keeps passing unchanged.
- [ ] Extend `api-bridge-main.ts` with a control surface on the existing postMessage channel (`kind`-discriminated, same shape as `bridge.context`):
  - `guard.enable` `{ binding: PaymentBinding }` → install a fetch/XHR guard implementing the **same decision logic** as the server `PaymentGuard.handle`: financial POSTs only (`financialUrl` + method POST), duplicate detection (`finalized` needs `sent`; a second `/pay` after `sent` is a duplicate), violation via `checkPaymentRequest`, block = do not forward + throw a `TypeError('Failed to fetch')` to the caller + `onPrevented(code)`; allow = forward, first `/pay` sets `sent` + `onSent()`, `/finalize` sets `finalized`; non-financial requests pass through untouched. Reply `{ ok: true }`.
  - `guard.disable` → remove the guard (after settle).
  - Observer (always on): record every request/response for BIG W payment endpoints (`/storefront/v1/cart/*/pay`, `/pay/finalize`) and Gr4vy vault endpoints (`api.wpay2.gr4vy.app/checkout/sessions/*/card-details`, POST) into a ring buffer (keep last 20) with `{ url, method, status, bodyText }` (body truncated to 32 KiB). Expose `observe.list` → `{ entries }`; `observe.clear`.
  - Notifications to the SW when the guard acts: post `{ channel:'duke', kind:'guard.event', event: { type:'sent'|'prevented'|'uncertain', code? } }` (the isolated relay must forward these to the SW — extend the relay: on `guard.event` messages, `chrome.runtime.sendMessage` from the isolated world, and the SW router filters them).
- [ ] Tests: port the logic-level cases from `tests/payment-guard.test.ts` against `payment-check.ts` (verify the move kept behavior — the original test file must stay green); new tests: guard.enable blocks a violating `/pay` POST (fetch stub records no call + caller sees rejection), allows a matching one (forwarded once), records observation entries, `observe.list` returns them.
- [ ] Verify: `npx vitest run` (server payment-guard tests unchanged + new), `npm run check`, `npm run build:ext`; commit.

### Task 4: Adapter Stage-2 methods (driver-backed fill/pay/reveal/clear/afterpay)

**Files:** modify `src/extension/lib/retailers/types.ts` (extend `BridgeHandle` with `driver`), `src/extension/lib/retailers/bigw/adapter.ts`; tests `tests/extension/bigw-adapter-stage2.test.ts`.

**DriverHandle capability** (implemented by the SW in Task 6, consumed by the adapter — keeps chrome out of the adapter):
```ts
export interface DriverFrame { frameId: number; url: string; type?: string }
export interface DriverHandle {
  frames(): Promise<DriverFrame[]>;                 // chrome.webNavigation.getAllFrames, type parsed from input.html?type=
  sendTop(message: unknown): Promise<unknown>;      // chrome.tabs.sendMessage(tabId, msg) — top frame
  sendFrame(frameId: number, message: unknown): Promise<unknown>;
  navigate(url: string): Promise<void>;             // chrome.tabs.update(tabId, { url })
  activate(): Promise<void>;                        // chrome.tabs.update(tabId, { active: true })
  observe(): Promise<{ entries: Array<{ url: string; method: string; status: number; bodyText: string }> }>; // via bridge observe.list
  guardEnable(binding: PaymentBinding): Promise<void>;
  guardDisable(): Promise<void>;
  url(): Promise<string>;                           // chrome.tabs.get(tabId).url
}
```
Add `driver: DriverHandle` to `BridgeHandle`.

Adapter methods to port (from `payment.ts` + `bigw.ts`, behaviour-identical):
- `revealPrepared(prepared, report, signal, opts?)`: if `opts?.reuseMountedPage` and driver URL is on `/checkout/` → `driver.activate()` + `ready()`; else `report('payment', 'Opening the prepared checkout.')` → `driver.navigate('https://www.bigw.com.au/checkout/delivery')` → `driver.activate()` → `guardDisable()` (a fresh navigation invalidates any guard) → `ready()`.
- `ready(signal)`: port the polling/already-open logic: poll `driver.sendTop({type:'driver.ready'})`; support `PAYMENT_NOT_READY` (60 s) and the Continue-to-Payment fallback (`CONTACT_REQUIRED` after 30 s), including the "reopen checkout" recovery using `driver.url()`/`driver.navigate()`.
- `fillCard(card, opts)`: saved-card → bridge `saved-cards` check identical to `payment.ts`; new-card → the full 5-pass loop from `payment.ts` `fill()` using driver primitives: `driver.newCardView()`, wait for `driver.ready().hasThreeFields` (25 s first pass / 12 s), fill each type via `driver.sendFrame(<frame of type>, { type:'driver.field.set', value })`, read back via `driver.field.get` (valuesPersisted), the 1.2 s settle, the programmaticSubmit early return, and the assist-only 3 s re-fill window (700 ms) — identical timings and error codes (`CARD_FIELDS`).
- `pay(prepared, card, onActionRequired)`: port `submit()` end-to-end: enable the guard with the binding (sessionId parsed from the number frame URL `input.html?type=number&sessionId=…` — `CARD_SESSION` block if missing); observer-driven response handling using `driver.observe()` polling (700 ms — replaces the page `response` events): find `isPaymentEndpoint` entries → `interpretPaymentResult`, vault-endpoint 4xx → fail fast; `requestfailed` equivalent = an observed entry with status 0; `driver.state()` polling for challenge (`onActionRequired`) and `confirmed` + `/checkout/confirmation` + pendingReference → confirmed; deadlines 300 s unknown / 20 s vault-unknown; new-card: the re-fill + re-click-Pay loop (6 attempts, 4 s waits) driven by `driver.clickPay()`; saved-card: `bridgeRequest('/storefront/v1/cart/{id}/pay', 'POST', {...})` identical body (deviceFingerprint via `page.evaluate('window.gr4vyAntiFraud?.f')` → replaced by a MAIN-world `guard.antiFraud` read — add `{ kind:'observe.antiFraud' }` returning `window.gr4vyAntiFraud?.f || ''`), then `interpretPaymentResult`, then `approvalUrl` navigation via `driver.navigate` (https-only guard identical).
- `clearSensitiveFields()`: port `clear()` using `driver.field.clear` on each of the three frame types (only when `this.filled`).
- `startAfterpay()`: port from `bigw.ts` using `driver.clickAfterpay()` + `driver.activate()`; return whether the hand-off was detected.

**Tests (stub driver + stub bridge):** fill success path (three frames, values persist); fill rebuild-then-succeed path; `CARD_FIELDS` failure; pay confirmed via observed `{status:200, bodyText: orderNumber}`; pay declined via observed `{status:409, errorCode: INVALID_PAYMENT}`; vault 4xx fail-fast message; saved-card pay body shape; guard blocked → `PAYMENT_BLOCKED`-style outcome (`status:'blocked'`, code from onPrevented).

- [ ] TDD → full suite → check → build:ext → commit.

### Task 5: RunManager port (SW orchestration)

**Files:** create `src/shared/cart-guard.ts` (move `guardCart` verbatim; `src/server/checkout.ts` imports + re-exports), create `src/extension/background/run-manager.ts`; test `tests/extension/run-manager.test.ts` (fake adapter, mocked `chrome.storage`).

- [ ] Move `guardCart` to `src/shared/cart-guard.ts`; server re-exports (server suite stays green).
- [ ] Port `src/server/checkout.ts` `RunManager` to `src/extension/background/run-manager.ts` with these adaptations only:
  - storage: `getHistory`/`pushRun` (history) + `chrome.storage.session` key `dukeRunState` holding `{ activeRun }` for recovery; `init()` marks `running` → `payment_unknown` if `paymentSubmittedAt` else `failed` `INTERRUPTED` (same messages as server).
  - events: `broadcast({ type:'run.update', payload: sanitizeRun(run) })` instead of EventEmitter.
  - no keeper interval (Stage 1 keeper owns it).
  - `start(raw)` uses `validateRun` + the requestId dedupe from the server version; single-active-run guard unchanged.
  - `execute()` logic **verbatim** (fast/standby/full paths, verify+guardCart, modes, assist keepFilledCard, pay outcome handling, finally clearing/card wipe, history write).
  - `sanitizeRun`: port from `src/server/storage.ts` (move to shared if it references server-only things — check; prefer moving to `src/shared/run-sanitize.ts` with a server re-export).
- [ ] Tests: port the meaningful cases from `tests/checkout.test.ts` against the extension manager + fake adapter: prepare completes ready; purchase confirmed/declined/blocked/unknown mapping; assist leaves card and verifies; cancel → cancelled; armed fast path falls back when verify throws; guardCart budget rejection; requestId dedupe; recovery on init.
- [ ] Verify: full suite (server + extension), check, build:ext; commit.

### Task 6: SW router extension + keep-alive + driver capability

**Files:** modify `src/extension/background/service-worker.ts`; create `src/extension/background/driver.ts`; test extend `tests/extension/state.test.ts` (tiny) or new `tests/extension/driver.test.ts` for frame-type parsing.

- [ ] `driver.ts`: build a `DriverHandle` for a tab: `frames()` via `chrome.webNavigation.getAllFrames({ tabId })` mapping URL → `type` from `input.html?type=`; `sendTop`/`sendFrame` via `chrome.tabs.sendMessage`; `navigate`/`activate`/`url` via `chrome.tabs`; `observe`/`guardEnable`/`guardDisable` via `bridgeRequest` control messages (`{ path: '/__duke/observe.list' }` style is NOT allowed by pageRequest's origin/path guard — instead add a dedicated relay message `{ type:'bridge.control', control: { kind, payload } }` handled by the isolated relay straight to the MAIN world, returning the reply; add it in this task to `api-bridge-isolated.ts`).
- [ ] Extend the adapter acquire to include `driver` (built per tab).
- [ ] Router: add `run.start` (validate + manager.start), `run.list`, `run.cancel`, `run.resolve`, `cards.list` (adapter.listCards via bridge). Broadcast `run.update` from the manager. Keeper unchanged (it must skip while a run is active: read the manager's activeRunId in the keeper's readState and return `armed:false` when a run is active — one line, documented).
- [ ] Keep-alive: `chrome.runtime.onConnect` — a `duke-run` port from the app page; on `run.start`, ensure an app page exists (`chrome.runtime.getContexts({ contextTypes: ['TAB'] })` filtering the app URL; else `chrome.tabs.create({ url: chrome.runtime.getURL('app.html'), active: false })`) so a port keeps the SW alive for the run. Document the 5-minute port limit as the known bound.
- [ ] Tests: frame-type parsing unit test; router dispatch smoke with mocked chrome (optional if heavy — the integration test covers it).
- [ ] Verify: full suite, check, build:ext; commit.

### Task 7: Run UI (modes, card, progress, cancel, resolve)

**Files:** modify `src/extension/app/App.tsx`, `src/extension/app/transport.ts` (add `connectRunPort`), reuse `src/client/components.tsx` widgets.

- [ ] Add: mode selector (4 modes, `aria-pressed`, same labels as the server client), card section for assist/purchase (new card: number/expiry/cvv; saved card: select from `cards.list` + cvv; refresh button), Start button (disabled while busy/active/!budgetValid/!profileComplete), payload `{ requestId, productUrl, quantity, maxTotalCents, mode, profile, card }` (requestId regenerated per start, reset on accept).
- [ ] Run surface: live progress (stage, elapsed from `run.update` events via port or onEvent), cancel button (`run.cancel`), resolve panel for `payment_unknown` (confirmed/not_purchased + order number, `run.resolve`), history list refresh.
- [ ] Port `PaymentFields`, `RunSummary`, `RunHistory` from `src/client/components.tsx` (check imports first; hand-roll if they drag HTTP/browser assumptions — keep the same class names).
- [ ] Verify: check, build:ext; the integration tests (Task 8) drive this UI. Commit.

### Task 8: Integration tests (purchase / declined / assist / cancel)

**Files:** `tests/extension/integration-stage2.test.ts` (+ a fixture server module `tests/extension/fixture-retailer.ts` extending the Stage-1 interception with: `/checkout/delivery` HTML containing 3 gr4vy input iframes + new-card radio + Pay button; gr4vy `input.html` pages with a single input; `POST /storefront/v1/cart/*/pay` returning configured outcomes; vault endpoint).

- [ ] Scenario 1 (purchase confirmed): arm not required; run mode purchase → fill → Pay click observed → fixture `/pay` returns `{ orderNumber: 'ORD-1', status: 'CONFIRMED' }` → assert run `succeeded` + `orderNumber 'ORD-1'`, history updated, card storage cleared (session) per default.
- [ ] Scenario 2 (declined): fixture `/pay` 409 `{ errorCode: 'INVALID_PAYMENT' }` → assert `failed` `PAYMENT_DECLINED` + card kept in fields (keepFilledCard) + run recorded.
- [ ] Scenario 3 (assist): fill only → run `ready`, no `/pay` observed, card present in the field frames.
- [ ] Scenario 4 (cancel): purchase run cancelled during fill → `cancelled`, no `/pay` observed.
- [ ] Keep runtime bounded: each scenario < 60 s; reuse the Stage-1 launcher + interception patterns; assert zero runtime errors.
- [ ] Verify: `npx vitest run tests/extension/integration-stage2.test.ts` twice, full suite, `npm run test:browser` still 9/9; commit.

---

## Stage-2 exit criteria
- purchase/assist/prepare/afterpay reach parity with the server app (endpoints, guards, messages, single-submission fence)
- the payment guard blocks changed/duplicate submissions inside the extension (unit + integration proven)
- run history + recovery work across SW restarts (session state)
- full suite green (server + extension + Stage-1 + Stage-2 integration), `npm run build`, `npm run build:ext` clean
