# Duke Checkout — Chrome Extension (MV3) Design

Date: 2026-10-16
Status: Approved design (pending implementation plan)
Supersedes: local Node server architecture (`src/server/*` + `src/client/*` at 127.0.0.1:4317)

## 1. Goal

Turn the local BIG W checkout bot into a Chrome extension so other users can install it on
their own machines with near-zero setup, while **all browsing execution stays on the user's
local Chrome** (their signed-in session, their fingerprint — never a server).

## 2. Audience & distribution decisions

- **Audience**: small private group (friends). No Web Store publishing.
- **Distribution**: private `.crx` + `update.xml` hosted on GitHub Releases. Friends install
  once from a link; Chrome auto-updates within hours of each release.
- **Scope**: BIG W only at first, behind a retailer-adapter boundary so a second retailer can
  be added later without a rewrite.
- **One-click behavior**: true auto-submit (chip click → order placed), by explicit choice of
  the group. A confirm-before-pay toggle exists in settings for anyone who wants a fence.

## 3. Architecture

```
┌─ User's Chrome ──────────────────────────────────────────────┐
│  Extension page (app.html)            React UI (ported)     │
│    ↕ chrome.runtime messages                                 │
│  Service worker                       RunManager, guards,   │
│                                       arm/standby, keeper   │
│  Content scripts                                            │
│   • link-scout (<all_urls>)           hover chip, triggers  │
│   • api-bridge (bigw, MAIN world)     token + API fetches   │
│   • checkout-driver (bigw)            ready/fill/submit     │
│   • same scripts inside Gr4vy         secure-field fill     │
│     iframes (host_permissions)                              │
└──────────────────────────────────────────────────────────────┘
```

### Eliminated from the current architecture
- Node/Express server, port 4317, CSRF/local-token HTTP auth
- CDP debugging, `chrome://inspect`, Chrome's native "Allow" approval prompt
- File-based storage (`data/`) → `chrome.storage`

### Retained concepts
- Work-tab pattern: with no BIG W tab open, the service worker opens a **background** BIG W
  tab and injects the api-bridge into it (replaces today's robots.txt preparation tab).
- All safety logic: PaymentGuard request binding, budget/address/contact guards, card never
  persisted, single-submission fence, `payment_unknown` outcome handling.
- Modes: prepare / fill-only / purchase / afterpay, plus arm/standby pre-preparation.

## 4. Components

### 4.1 Service worker (background)
- Owns `RunManager` (state machine, event log, guards), arm/standby state, settings.
- Coordinates runs; long waits execute in content scripts (see 4.5).
- Persists run state to `chrome.storage.session`; history to `chrome.storage.local`.

### 4.2 Extension page (`app.html`)
- Ported React client (App, fields, run history). Transport swaps from HTTP to
  `chrome.runtime` messaging (request/response + port for live events).
- Onboarding (first run), settings, live run progress, history.

### 4.3 `link-scout` content script (`<all_urls>`, `document_idle`)
- One delegated `mouseover` listener; checks `closest('a[href]')` against the BIG W product
  URL regex. No DOM scanning, no network on hover.
- On a match, after a ~150 ms hover delay, shows a chip near the link with two actions:
  **Checkout now** (one-click run with defaults) and **Arm** (prepare only).
- Setting to disable the chip entirely.

### 4.4 Trigger paths (all feed one entry point)
1. Hover chip (any site — Discord, forums, chat).
2. Context menu on any link: "Duke: one-click checkout this link".
3. Keyboard shortcut (default `Alt+Shift+D`, remappable) on the last hovered product link.
4. The extension page's product-URL field (current flow).
Chip click when preconfiguration is incomplete opens onboarding for exactly the missing
piece (profile or card), then continues the run. A click is never silently dropped.

### 4.5 `api-bridge` content script (BIG W, main world)
- Port of `PAGE_REQUEST`/`PAGE_CONTEXT`: reads the Auth0 SPA token from `localStorage`,
  performs same-origin API fetches with the correct scopes/headers.
- Injected on demand into the work tab or the user's existing BIG W tabs.

### 4.6 `checkout-driver` content script (BIG W checkout, isolated world + Gr4vy iframes)
- Port of the payment driver: ready detection, card fill (values + events inside Gr4vy
  secure fields via `host_permissions`), rebuild detection via `MutationObserver`
  (replaces polling), Continue-to-Payment handling, Pay submission, response observation,
  saved-card selection, Afterpay hand-off.
- Carries long waits (field readiness, fill stabilization, submit response) so service-worker
  sleep cannot kill a run mid-flight. Reports progress to the SW, which relays to the UI.

### 4.7 MV3 lifetime strategy
- **Keeper**: `chrome.alarms`, 1-minute period. Wakes the SW; refreshes the retailer session
  when the token is near expiry (reload of the checkout/product page in the work tab),
  exactly like the current `keepSessionFresh` (threshold < 4 min).
- **Active run**: waits live in content scripts; the SW only coordinates and relays. Run
  state machine is persisted to `chrome.storage.session` at every transition so a SW
  restart resumes or reports cleanly instead of losing the run.
- **Arm/standby state**: `chrome.storage.session` (survives SW restarts, cleared on browser
  exit — matching the current in-memory semantics).

### 4.8 Storage map
| Data | Store | Notes |
|---|---|---|
| Settings (defaults, toggles) | `chrome.storage.local` | sync candidate later |
| Profile (contact/delivery) | `chrome.storage.local` | imported from BIG W |
| Run history | `chrome.storage.local` | replaces `data/runs.json` |
| Card + CVV (session-only) | `chrome.storage.session` | wiped on browser close; optional "clear after every order" |
| Arm/standby state | `chrome.storage.session` | |
| Active run state machine | `chrome.storage.session` | SW-restart recovery |

## 5. Defaults & settings (first-run onboarding → two minutes, once)

| Setting | Default |
|---|---|
| Quantity | 1 |
| Max delivered total (AUD) | 1000.00 |
| Mode | Purchase automatically (auto-submit) |
| Contact/delivery | Imported BIG W profile |
| Confirm before pay | Off (true one-click) |
| Hover chip | On |
| Auto-arm | On |
| Card handling | Keep for browser session (wiped on close) |

First-run onboarding: open BIG W → "Import my profile" → enter card once. Each later chip
click needs nothing from the user.

## 6. Arming

- Levels carried over from the local app: **cart-ready** (product purchasable → full prep)
  and **standby** (pre-release product → session/product/page prepared, cart added at drop).
- **Auto-arm (default on)**: opening a compatible BIG W product page triggers a background
  arm with the configured defaults. Debounced; re-arms only when the product changes; hover
  alone never causes network calls. Visiting the page is the intent signal.
- Chip **Arm** button arms from any site without visiting BIG W (background work tab).
- Armed state is surfaced in the badge and the extension page; a matching one-click run uses
  the armed fast path (~7 s to payment response) or standby path (cart added at drop).

## 7. Retailer adapter boundary

```
src/retailers/
  registry.ts          // resolves adapter by URL pattern
  types.ts             // RetailerAdapter: inspect/prepare/verify/arm/disarm/
                       //   keepFresh/fill/pay/clearSensitive/urlPattern
  bigw/                // all BIG W specifics (endpoints, page driving, guards)
```
Service worker, UI, guard framework, and triggers are retailer-agnostic. A second retailer
is a new folder plus a registry entry.

## 8. Progress & feedback

- Extension badge: live run state (`…` running, `✓` ordered, `✗` failed, `a` armed).
- System notification on outcome (order number / decline / attention needed).
- Clicking the badge opens the full progress tab.

## 9. Security & safety (unchanged guarantees)

- Card/CVV only in `chrome.storage.session` + run memory; never `local`, never logs.
- Outgoing `/pay` bound to cartId/version/amount/session; single-submission fence.
- Budget, exact product/quantity, and address/contact guards run on the authoritative cart
  before every submission, including armed fast paths and one-click runs.
- Extension messaging is origin-secured (chrome.runtime); no HTTP surface to protect.

## 10. Distribution & updates

- `npm run pack:crx` → packs `.crx` + `update.xml` using a maintained private key.
- Published to GitHub Releases (private repo); `update.xml` points at the release asset.
- Friends: install once from the link; Chrome auto-updates. Fallback: load-unpacked zip.

## 11. Testing strategy

- Pure logic (model parsing, guards, validation, arm matching, settings defaults): port with
  existing vitest suites, extended for new settings.
- Content-script drivers: integration suite loading the unpacked extension into a fixture
  Chrome (puppeteer) against an intercepted retailer — port of today's controlled-browser
  tests, including the guard-block and one-click flows.
- Manual release checklist: install from CRX, onboarding, chip on Discord, auto-arm on a
  product page, one-click run, auto-update pick-up.

## 12. Out of scope (explicit)

- Multi-user server coordination, remote-config brain, per-OS builds.
- Web Store publishing.
- Non-Chrome browsers (Edge/Brave work via Chromium compatibility, untested officially).

## 13. Migration from the current app

- The local server app remains usable during the transition; the extension is a new
  build target in the same repo (`src/extension/`), reusing `src/shared/` and the pure
  modules (`bigw-model`, validation, guard logic).
- Delete the server code only after the extension reaches parity (all four modes + arm).
