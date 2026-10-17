# Duke Checkout Extension — Stage 3 Implementation Plan (Triggers & Onboarding)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Zero-distance triggering and first-run setup: a hover chip on any page containing a BIG W product link, a right-click menu, a keyboard shortcut, auto-arm on product-page visits, a state badge, outcome notifications, and onboarding that imports the BIG W profile — all feeding the already-working run engine.

**Architecture:** `link-scout` (all URLs) detects product links and renders a shadow-DOM chip → SW trigger handlers; `chrome.contextMenus`/`chrome.commands`/`chrome.tabs.onUpdated` are additional trigger sources; the SW owns trigger policy (settings, profile/card readiness, keep-alive) and starts runs or opens the app page as needed. Onboarding is an app-page mode backed by a ported `importProfile` from the server adapter.

**Prereq:** Stages 1-2 merged (`run.start` etc. work; armed fast paths wired; integration harness in `tests/extension/fixture-retailer.ts`).

**Port references:** `src/server/browser/bigw.ts` (`importProfile`, `savedCards`), `src/shared/validation.ts` (`parseProductLink`), `src/extension/lib/storage.ts` (settings incl. `hoverChip`, `autoArm`, `confirmBeforePay`).

---

### Task 1: link-scout hover chip (+ respond-contract test rider)

**Files:** `src/extension/content/link-scout.ts`; `tests/extension/link-scout.test.ts` (jsdom); rider in `tests/extension/checkout-driver.test.ts`; manifest `content_scripts` for link-scout gains no change (already `<all_urls>`).

- [ ] Product URL regex: `^https?://(www\.)?bigw\.com\.au/product/[^/]+/p/\d+` (mirror `parseProductLink` accepting absolute URLs).
- [ ] Delegated `mouseover` on `document` (capture), `event.target.closest('a[href]')`; ignore if not a product link; after ~200 ms of continued hover show the chip anchored near the link (position from `getBoundingClientRect`), inside a **shadow DOM** host with `position: fixed`, `z-index: 2147483647`, `all: initial` reset; dismiss on `mouseout` (leaving both link and chip), scroll, or Escape.
- [ ] Chip contents: product link label "Duke ▸ checkout" + two buttons — **Checkout now** and **Arm**. Buttons post `chrome.runtime.sendMessage({ type: 'trigger.checkout' | 'trigger.arm', url })` (guarded/caught) and hide the chip.
- [ ] Feature gate: read `hoverChip` from storage (`chrome.storage.local.get(['dukeSettings'])`) lazily on first hover (cache it; refresh via a `chrome.storage.onChanged` listener). If false, do nothing.
- [ ] Never interfere with the page: no DOM outside the shadow host, no global CSS, no location/history changes; do not preventDefault.
- [ ] Ordering note: message types are namespaced (`trigger.*`, `bridge.*`, `driver.*`) — add a header comment stating the ownership table so the shared-frame ambiguity fixed in Stage 2 cannot regress.
- [ ] Tests (jsdom): detection only for product links; chip appears after hover delay (fake timers) with two buttons; buttons send the right messages; dismissed on mouseout; disabled when `hoverChip` false; no sendMessage without `chrome.runtime?.id`.
- [ ] **Rider:** in `tests/extension/checkout-driver.test.ts` add the missing regression test: `onMessage({type:'bridge.request'})` and `{type:'bridge.control'}` on a checkout frame return `false` and do NOT call `sendResponse` (Stage-2 fix lock-in).
- [ ] Verify + commit.

### Task 2: context menu, keyboard shortcut, last-hovered-link tracking

**Files:** `src/extension/background/triggers.ts` (new), `src/extension/content/link-scout.ts` (report last hovered link), `src/extension/background/service-worker.ts` (register), manifest (`commands`).

- [ ] `link-scout`: on product-link hover (before the chip appears) `chrome.runtime.sendMessage({ type: 'trigger.hovered', url })` (guard+throttle ≥1/500 ms per URL); the SW records `tabId → url`.
- [ ] `triggers.ts`:
  - `registerContextMenus()`: `chrome.contextMenus.removeAll` then create `duke-checkout` ("Duke: one-click checkout this link") and `duke-arm` ("Duke: arm this product"), `contexts: ['link']`; `onClicked` handler: `info.linkUrl` must be a product URL → dispatch the same trigger action as the chip.
  - `registerCommands()`: manifest `"commands": { "duke-checkout": { "suggested_key": { "default": "Alt+Shift+D" }, "description": "Duke: checkout / arm the last product link" } }`; `chrome.commands.onCommand` → use the active tab's last hovered product URL (fallback: the tab's own URL if it is a product page) → dispatch. If nothing to act on, `chrome.notifications` a one-line hint (Task 4 provides the helper; for now `console.log` + badge flash).
- [ ] Unit tests for the pure helpers: `isProductUrl`, `productCodeFrom` (reuse `parseProductLink`), and the last-hovered-link store (set/get/clear per tab; cleared on tab navigation).
- [ ] Verify + commit.

### Task 3: trigger policy in the SW (one-click flow) + auto-arm + badge

**Files:** `src/extension/background/triggers.ts` (dispatch), `service-worker.ts` (tabs.onUpdated), `src/extension/background/badge.ts` (new).

- [ ] `dispatchTrigger(action: 'checkout' | 'arm', url, tabId?)` in `triggers.ts`:
  1. `parseProductLink(url)` → invalid → notification hint, done.
  2. Load `getSettings()` + `getProfile()`.
  3. If no profile: open/focus the app page with `?onboarding=1&product=<url>` (Task 5) so the user completes setup, then stop.
  4. `action === 'arm'` → run `adapter.arm(...)` with the defaults (quantity/mode/profile) in the background (reuse: the SW's existing arm handler logic; extract it to a shared `armProduct(url)` function used by both the message handler and triggers). No card needed.
  5. `action === 'checkout'`: if `settings.confirmBeforePay` → open/focus the app page with `?product=<url>` prefilled and stop (the user presses Start). Else: if the mode needs a card and none is available in the session store (`chrome.storage.session` `dukeCard`) → open the app page with the product prefilled and a hint; else `ensureAppPage()` then `manager.start({...defaults, productUrl, card:<from session>})`.
  6. Card for one-click: add `chrome.storage.session` key `dukeCard` (written by the app page when the user saves card entry with "remember for this browser session", default on, cleared on browser close; honour `settings.cardClearAfterOrder` by clearing after a terminal run). Never `storage.local`.
- [ ] Auto-arm: `chrome.tabs.onUpdated` (status complete) → if the tab URL is a product page AND `settings.autoArm` AND (no armed state OR armed.productUrl !== url) → debounce 1 s → `armProduct(url)` in the background (best-effort, errors only logged; never opens onboarding automatically). Also arm when the same product is already armed → no-op.
- [ ] `badge.ts`: `setBadge(state: 'idle'|'armed'|'running'|'succeeded'|'failed')` → text (`''`, `a`, `…`, `✓`, `✗`) + colours; call from the run manager's broadcast path (subscribe to run.update in the SW), the arm handlers, and trigger dispatch.
- [ ] Tests: pure helpers (`shouldAutoArm(settings, armed, url)`, `triggerPlan(settings, profile, card, mode) → 'open-onboarding'|'open-app'|'arm'|'start'`), the session card store (set/get/clear), debounce behaviour with fake timers.
- [ ] Verify + commit.

### Task 4: outcome notifications

**Files:** `src/extension/background/notify.ts` (new), `service-worker.ts` (wire).

- [ ] `notifyOutcome(run)`: `chrome.notifications.create` with a stable id per run: title `Duke Checkout`; message by status — succeeded: `Order placed. Reference <orderNumber>.`; failed: the run's error message; payment_unknown: "Check BIG W orders — the payment outcome is not confirmed."; action_required: "Your bank needs authentication — complete it in the BIG W tab."; ready (assist): "Card filled — press Pay in the BIG W tab."; cancelled: no notification.
- [ ] Wire: subscribe to the manager's `run.update` broadcasts in the SW; notify once per run on the first terminal status (dedupe via a `Set` of run ids already notified).
- [ ] Manifest already has `notifications`. Add an icon requirement: Chrome requires `iconUrl` for notifications — reference the extension's existing icon (add `icons` to the manifest if absent: generate a small PNG set from the existing `public/` favicon or a simple 128px PNG; if no icon asset exists, create one 128×128 PNG placeholder and document it as a release TODO).
- [ ] Tests: `notificationFor(run)` pure mapping (status → title/message/null) across all statuses.
- [ ] Verify + commit.

### Task 5: onboarding + profile import + app-page trigger mode

**Files:** `src/extension/lib/retailers/bigw/adapter.ts` (add `importProfile`), `src/extension/background/service-worker.ts` (`profile.import` handler; open app page with query params), `src/extension/app/App.tsx` (onboarding mode + product prefill + session card store write).

- [ ] Port `importProfile` from `src/server/browser/bigw.ts` to the extension adapter (bridge-backed, identical mapping: `/profile/v1/addresses`, `/profile/v1/profile`, cart GET when context has a cart id — in the extension there is no page context, so skip the cart read and use the primary address; `savedCards()`), returning `{ profile, savedCards }`. Document the cart-read skip as a deviation.
- [ ] Add protocol `profile.import` (RequestType already has `profile.get/put`; add `profile.import`) → SW handler calls `adapter.importProfile()` and returns it (the UI saves it with the existing `profile.put` or uses the response directly).
- [ ] App page: read `?onboarding=1` / `?product=<url>` on mount:
  - onboarding → a first-run panel: "Import my BIG W profile" button (`profile.import` → fills the profile card), card entry with a "Remember for this browser session" checkbox (default on) → writes `chrome.storage.session` `dukeCard` (number/expiry/cvv), and a "Finish setup" that clears the query string.
  - `?product=` (no onboarding) → prefill the product URL field and, when the mode needs a card and `dukeCard` exists, prefill the card fields from it (masked as normal inputs).
- [ ] `settings.cardClearAfterOrder`: the SW clears `dukeCard` on a terminal run when enabled.
- [ ] Tests: `importProfile` mapping with stubbed bridge (addresses/profile/cards shapes from the server's `importProfile`/`savedCards`); `shouldRememberCard`/session-card read-write; a pure `onboardingPlan(params)` helper if the query parsing is nontrivial.
- [ ] Verify + commit.

### Task 6: Stage-3 integration tests + exit review

**Files:** `tests/extension/integration-stage3.test.ts` (reuse `fixture-retailer.ts`).

- [ ] Scenario 1 (chip → one-click): a fixture page on a *foreign* origin? Content scripts run on `<all_urls>` but the fixture must be served over http(s) — add an intercepted `http://127.0.0.1:<port>/discord-like` route (or reuse the app's own server if still running — prefer a puppeteer-served `page.setContent` with `page.goto('http://localhost:PORT/x')` intercepted). The page contains `<a href="https://www.bigw.com.au/product/example/p/6071620">…</a>`; hover the link, wait for the chip (shadow DOM — pierce via `page.evaluate` querying the host's `shadowRoot`), click **Checkout now** with profile+card+settings pre-seeded in storage → assert a run starts and reaches the fixture's outcome (`succeeded` with `ORD-1`), asserting exactly one `/pay` POST.
- [ ] Scenario 2 (chip → Arm): click **Arm** → assert the armed state appears in `chrome.storage.session` at the right level.
- [ ] Scenario 3 (auto-arm): enable `autoArm`, navigate the tab to the fixture product page → assert armed state appears without any click (debounce bounded).
- [ ] Scenario 4 (shortcut/context-menu → arm): invoke `chrome.commands`/context-menu equivalent via `chrome.tabs.sendMessage` of the `trigger.hovered` + `chrome.commands.onCommand` cannot be triggered programmatically — instead assert the SW's `dispatchTrigger('arm', url)` path directly by sending the internal message the menu handler sends (document that the OS-level menu/shortcut surface itself is manual-only).
- [ ] Scenario 5 (onboarding): with no profile, trigger a checkout → assert the app page opens with `?onboarding=1`; click the import button (fixture profile endpoints) → assert the profile fields populate and save.
- [ ] Keep each scenario < 90 s; zero runtime errors; Stage-1/2 integration tests untouched and green.
- [ ] Verify (twice), full suite, `npm run check`, `npm run build:ext`, `npm run test:browser`.

---

## Stage-3 exit criteria
- A BIG W product link on any page offers chip / menu / shortcut triggers; checkout-now is one click when profile+card defaults exist.
- Auto-arm works on product-page visits (debounced, no tab spam) and never prompts unexpectedly.
- Badge reflects armed/running/outcome; notifications announce outcomes once.
- Onboarding imports the BIG W profile and can remember a session-scoped card; `cardClearAfterOrder` honoured; no card in `storage.local`.
- Full suite green; both builds clean.
