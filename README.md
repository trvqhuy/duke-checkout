# Duke Checkout

**Status:** the product is now a Chrome (Manifest V3) extension. Stages 1–3 are
shipped — settings/inspect/arm, guarded checkout runs, and the trigger/onboarding
surface. Stage 4 is distribution: the signed CRX pack, the self-hosted
`update.xml`, and the install/release/security documentation below.

Duke prepares or places a **BIG W Australia** order using your own existing
Chrome session. It runs entirely inside your browser: there is no local server,
no Chrome DevTools Protocol connection, and no background daemon. Card entry uses
BIG W's own Gr4vy/Wpay secure fields. This repository also contains the original
localhost web app (`src/server` + `src/client`), kept as a legacy tool — see
[Legacy local app](#legacy-local-app).

## Duke Checkout (extension)

The extension has three surfaces, all backed by one service worker:

| Surface | Where | What it does |
| --- | --- | --- |
| **App page** | Options page and toolbar popup (`app.html`, `app.html?popup=1`) | Settings, profile, product inspect, arm, card entry, live run progress, and run history/resolution. |
| **Hover chip** | Any web page (`content/link-scout.ts`) | Hover a BIG W product link to get **Checkout now** and **Arm**. |
| **Triggers** | Context menu and keyboard | Right-click a link for **Duke: one-click checkout this link** / **Duke: arm this product**; press `Alt+Shift+D` to check out the last hovered product link. Auto-arm can also arm a product page on load when enabled. |

Every checkout step — token resolution, API calls, cart/contact/payment
preparation, and payment submission — executes locally in the user's Chrome via
content scripts and the service worker. Nothing is driven through CDP, and no
checkout traffic leaves the machine except the requests to BIG W and the payment
providers listed in the manifest.

Requirements: Node **22.20 or newer** and a Chrome (or Chromium) browser with the
extension loaded.

## Install (developer)

```sh
npm install
npm run build:ext
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the built `dist-extension/` directory.
4. In that same Chrome, sign in to BIG W once (open `bigw.com.au`).
5. Click the Duke toolbar icon to onboard: **Import my BIG W profile**, then
   enter a card and use the **Remember this card for this browser session**
   checkbox, then **Finish setup**.

The checked-in `src/extension/manifest.json` never contains `update_url`, so an
unpacked developer build does not try to self-update.

## Install (friend) + auto-update

You send two things: the hosted `update.xml` URL (the `update_url`) and the
`duke-checkout.crx`. On Linux, Chrome for Testing, and Chromium, the friend can
open `chrome://extensions`, enable **Developer mode**, and drag `duke-checkout.crx`
into the page.

On **Windows and macOS**, Chrome blocks off-store `.crx` installs even in
Developer mode. The robust path there is an enterprise policy that force-installs
and auto-updates from your host:

- Policy: `ExtensionInstallForcelist`
- Value: `"<extension-id>;<update_url>"` (the `extension-id` is printed by the
  packer; `update_url` is the hosted `update.xml`)

**Auto-updates require a release pack.** Only a build packed with
`DUKE_UPDATE_URL` set gets `update_url` injected into its manifest; that manifest
points Chrome at your hosted `update.xml`, which Chrome re-checks every few
hours. A local/test pack (no `DUKE_UPDATE_URL`) never updates.

**Reuse the same private key forever.** The extension ID is derived from the
signing key (`./duke-extension.pem`, or `DUKE_CRX_KEY`). Regenerating it changes
the extension ID: every existing install becomes a different extension that will
never receive updates, and its settings/session state do not carry over. Keep the
`.pem` secret (anyone with it can sign an update for every install) and back it up
privately. It is git-ignored (`*.pem`).

## Release checklist

1. Bump `version` in `src/extension/manifest.json` (for example `0.1.0` →
   `0.2.0`).
2. Run the suite and typecheck:
   ```sh
   npx vitest run
   npm run check
   ```
3. Pack the signed release (the packer runs `npm run build:ext` itself):
   ```sh
   DUKE_UPDATE_URL=<host>/update.xml DUKE_CRX_KEY=./duke-extension.pem npm run pack:crx
   ```
   This writes `release/duke-checkout.crx` and `release/update.xml`. The
   `DUKE_UPDATE_URL` value is injected verbatim as the manifest's `update_url`,
   so it must be the URL that serves the update XML (the hosted `update.xml`).
   Set `CHROME_PATH` only if Chrome is not in a standard location.
4. Upload `release/duke-checkout.crx` and `release/update.xml` to the same
   directory that `<host>` serves.
5. Confirm the `version` in `update.xml` matches the manifest version you bumped.
6. Tell the group. Installs with a working `update_url` pick the release up
   within hours; anyone who never installed it can reinstall the `.crx`.

## Security model

The extension is built so a web page cannot spend on the user's behalf, and so a
run cannot submit anything the user did not set up.

### Trigger threat model

- **One-click spending needs a real user gesture.** The hover chip only appears
  after a *trusted* `mouseover` from the browser's own pointer, and its buttons
  only act on *trusted* clicks. Events a page script synthesizes with
  `dispatchEvent`/`element.click()` are ignored, so a hostile page cannot move the
  user's intent onto a purchase. The chip's shadow root is `open` (so tests can
  read its geometry), but `isTrusted` — not the shadow boundary — is the gate.
- **`confirmBeforePay` forces a review step.** With it on, a trigger never starts
  a purchase directly; the app opens with the product so the user presses the
  final button.
- **The session card is opt-in and ephemeral.** A card is only remembered when
  the user ticks the remember checkbox, and it lives solely in
  `chrome.storage.session` — never in profiles, history, or `storage.local` — so
  it is wiped when the browser session ends. `cardClearAfterOrder` additionally
  clears it as soon as a run reaches a terminal state.
- **Auto-arm is rate-limited.** Auto-arm skips while a run is in flight and fires
  at most once per 5 s across all tabs, bounding retailer API calls.

### Payment submission guard

- **Single submission.** The payment guard allows only the first `/pay` or
  `/pay/finalize` request for a run. Re-clicking Pay during the secure-field
  rebuild cannot send a second payment.
- **Bound to the reviewed cart.** The outgoing request must match the cart id,
  cart version, delivered amount, and the current secure-fields session (or the
  selected saved card). A changed cart, total, session, or additional submission
  is blocked before transmission.
- **No automatic retry of a submitted payment.** An explicit rejection is treated
  as declined; an unknown network outcome is recorded as `payment_unknown` and
  never retried automatically.

### What it can and cannot do

- It **can** read the user's BIG W session token through the page bridge in the
  user's own tab, call BIG W APIs as that user, drive the checkout page (fill
  fields, click Pay/Afterpay), and store settings/profile/history locally.
- It **cannot** be triggered by a web page without a real user gesture.
- It **never sees card data outside a run**: card material is used for the one
  run that needs it and is only persisted to session storage when the user opts
  in.
- It **never sends anything to a third-party server.** Requests go only to the
  BIG W, Gr4vy/Wpay (secure fields), and Afterpay origins declared in the
  manifest's `host_permissions`.
- It runs **no local server and no CDP connection**.

For a shared or less-trusted machine, the recommended settings are: leave the
**Remember this card** checkbox unticked (so one-click runs prompt for the card
each time), enable **Ask before submitting payment**, and disable **auto-arm** and
the **hover chip**.

## Privacy / what is stored

Everything is local to the browser profile. No card material is ever written to
`storage.local`, and nothing leaves the machine.

| Area | Key | Contents |
| --- | --- | --- |
| `chrome.storage.local` | `dukeSettings` | Settings: quantity, maximum delivered total, mode, and the toggle options. |
| `chrome.storage.local` | `dukeProfile` | Delivery/contact/billing profile. |
| `chrome.storage.local` | `dukeHistory` | Sanitized run records (retention-capped). No card data, security codes, browser tokens, raw bodies, or address values. |
| `chrome.storage.session` | `dukeCard` | The one-run card (number, expiry, security code), only when the remember checkbox was ticked. |
| `chrome.storage.session` | `dukeArmed` | The armed checkout (prepared cart/session). |
| `chrome.storage.session` | `dukeRunState` | The in-flight run, so a restarted service worker can recover it. |

`chrome.storage.session` is in-memory and is cleared when the browser closes.

## Troubleshooting

Errors surface in the app page — as a run's error message or the app's error
banner — and a terminal run outcome also raises a notification. The common codes
and their one-line remedies:

| Code | Remedy |
| --- | --- |
| `LOGIN_REQUIRED` | Sign in to BIG W again in the BIG W tab, then run again. |
| `BRIDGE_UNREADY` | No BIG W tab, or the page bridge did not attach. Open `bigw.com.au` once (reload the tab), then retry. |
| `BRIDGE_NO_RESPONSE` | The BIG W page bridge did not answer in time. Reload the BIG W tab and run again. |
| `PAYMENT_NOT_READY` | BIG W's payment form never appeared. Check the checkout tab for a sign-in or address prompt, fix it, then prepare a fresh run. |
| `CONTACT_REQUIRED` | BIG W rejected the contact/address step. Check the profile's delivery and billing details, then prepare again. |
| `PAYMENT_DECLINED` | BIG W rejected the payment. Check the card details and try again, or use another card. |
| `payment_unknown` | The outcome is not confirmed (a drop or timeout after submission, reported as `PAYMENT_UNKNOWN`). Check BIG W order history, then use the run's **Resolve** controls to record the order number or mark it not purchased. Do not resubmit blindly. |
| `DRIVER_TIMEOUT` | A checkout content script did not respond. Reload the checkout tab and prepare again. |

Other messages you may see are variants of the same causes: `SESSION_EXPIRED` /
`BROWSER_ATTENTION` / `STORE_REQUEST` (BIG W / browser needs attention),
`REQUEST_TIMEOUT` / `REQUEST_NETWORK` (retry the page), `CARD_FIELDS` /
`CARD_SESSION` (secure fields not ready — prepare a fresh run),
`SAVED_CARD` (re-import the BIG W details), and `CART_CHANGED` /
`PAYMENT_CHANGED` (the guard blocked a submission because the cart, total, or
session changed — prepare a fresh run).

## Development

Test and build commands:

```sh
npx vitest run        # full unit + integration suite (build dist-extension/ first)
npm run check         # tsc --noEmit
npm run build:ext     # build dist-extension/ (runs check first)
npm start             # legacy local server at http://127.0.0.1:4317
npm run test:browser  # legacy end-to-end browser test (intercepts all requests)
```

The integration tests in `tests/extension/` load the built `dist-extension/` into
a fixture Chrome (`channel: 'chrome'`) and drive the real service worker, content
scripts, and app page against a fixture BIG W retailer. They need a fresh
`npm run build:ext` first (the suite asserts the build exists).

Repository layout:

- `src/extension/manifest.json` — MV3 manifest (permissions, commands, content
  scripts).
- `src/extension/background/` — service worker: run manager, triggers, arms,
  work tab, notifications.
- `src/extension/content/` — content scripts: the MAIN/ISOLATED BIG W page
  bridges, the checkout driver, and the hover chip.
- `src/extension/app/` — the React app page (options/popup).
- `src/extension/lib/` — storage, protocol, product-URL predicate, and the BIG W
  adapter under `lib/retailers/bigw/`.
- `src/shared/` — engine logic used by both the extension and the legacy server
  (types, validation, cart/payment guards, run history and sanitization).
- `src/server/` — **legacy** localhost app (Express + Puppeteer CDP).
- `src/client/` — **legacy** React UI; its components are also reused by the
  extension's app page.
- `tests/` — vitest unit tests; `tests/extension/` holds the fixture-Chrome
  integration harness.

## Legacy local app

`src/server` and `src/client` are the original localhost web app. They remain in
the repository and still work with the same commands:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4317** (development with reloads: `npm run dev`). Unlike
the extension, this app attaches to an existing Chrome over the Chrome DevTools
Protocol.

### Connect your existing Chrome (legacy)

1. In that Chrome browser, open `chrome://inspect/#remote-debugging` and enable
   **Allow remote debugging for this browser instance**.
2. Keep a BIG W tab open and sign in to your account.
3. Click **Connect Chrome** in Duke. Allow **Duke Checkout** in Chrome's native
   connection prompt if one appears.

Duke attaches to Chrome; it does not launch a separate shopping browser. Stopping
the app disconnects its automation client without closing Chrome. A connection
already granted to Chrome DevTools MCP does not automatically grant a separate
connection to this app.

### Use the form (legacy)

1. Paste a BIG W product URL and select a quantity.
2. Use **Import from BIG W**, choose a saved local contact profile, or enter your
   delivery details. Save the profile if you want to reuse it.
3. Enter the maximum **delivered** total in AUD. **Inspect** fetches the product,
   current price, and delivery availability; it fills an empty budget with the
   current estimate. You can edit that limit.
4. Choose an execution mode and press the start button.

| Mode | Behavior |
| --- | --- |
| **Prepare checkout** | Applies the cart, fulfilment, contact, and billing details, opens the payment step, and stops without entering or submitting payment. This is the default. |
| **Fill card only** | Does everything prepare does, then fills the card into BIG W's secure fields and stops. You press **Pay** in the tab to submit. Nothing is submitted by Duke, so there is no outcome to reconcile. |
| **Afterpay** | Does everything prepare does, selects **Afterpay**, and presses its button, which opens Afterpay's own checkout for you to sign in and confirm. No card needed. |
| **Purchase automatically** | Validates the selected card upfront, prepares checkout, fills the secure fields, and submits once. No second confirmation dialog is added. |

New-card fields are number, expiry (`MM/YY`), and security code. Saved BIG W cards
can be refreshed and selected with their security code. Card values are never saved
in profiles or history. In **prepare** and **Afterpay** modes no card is entered.
In **fill-only** mode the card stays in BIG W's secure fields for you to submit.
In **purchase** mode the card is submitted once; BIG W's own checkout then rebuilds
its payment form (which clears the fields), so use fill-only if you want to review
or edit the card before submitting. BIG W's current new-card handler saves a payment
method to the retailer account; that behavior is stated next to the card inputs.

After the checkout loads, BIG W rebuilds the Gr4vy secure card iframes a few times
while it settles, which discards anything already typed. Duke fills the fields,
reads them back, and re-fills until the values persist, so the card is really in
the fields that remain on screen. In purchase mode it also re-fills and re-clicks
Pay until a payment request is actually sent (the request guard still allows only
one submission), so a rebuild landing between the fill and the click cannot leave
the Pay press as a silent no-op.

If the checkout or issuer requests authentication, complete it in Chrome while
Duke waits for the merchant outcome. **Open BIG W tab** brings the working tab
forward. Cancellation is available before payment submission.

### What the engine checks (shared)

The extension and the legacy app run the same engine:

- The link is a secure BIG W article URL and the requested quantity is valid.
- The selected Australian delivery phone, address, and billing details are valid.
- Delivery availability is determined from the store's available flag, including
  preorder responses that report a zero stock quantity. If the advisory
  availability lookup is temporarily rejected by BIG W's edge, the run defers to
  the cart's authoritative fulfilment response instead of failing.
- The cart contains exactly the specified item and quantity. Other cart items
  are not cleared; a separate cart is created when necessary.
- The authoritative delivery/billing address, recipient, phone, cart version,
  and delivered total match the run's inputs.
- The outgoing payment is bound to that cart/version/amount and the current
  secure-fields session or selected saved card. Changed or additional payment
  submissions are blocked before transmission.

### Outcomes and recovery (shared)

An order is marked confirmed when the observed merchant transaction supplies an
order reference. An explicit rejection is distinct from an unknown network
outcome. Payment submissions are **not automatically retried**.

When an outcome is unknown it is recorded on the run; it does **not** block later
purchases. Check BIG W's order history and, if you want, use the run's resolution
controls to record the order reference or mark it as checked/not placed.
Interrupted post-submission runs recover as unknown after restarting the app.
Purchase records are retained independently of the recent-preparation history
limit.

### Local data and configuration (legacy)

The legacy server app listens on `127.0.0.1` and checks local Host/Origin and
request tokens. Contact profiles and sanitized run records are stored in `data/`
using private file permissions and atomic writes. That directory is git-ignored.
Card details, security codes, browser tokens, raw network bodies, and address
values in run history are excluded from persistence.

Copy `.env.example` to `.env` if configuration is needed:

| Variable | Default / use |
| --- | --- |
| `PORT` | `4317` |
| `DATA_DIR` | `./data` |
| `CHROME_USER_DATA_DIR` | Auto-detected Chrome profile root containing `DevToolsActivePort` |
| `BROWSER_WS_ENDPOINT` | Optional explicit browser WebSocket endpoint; conventional `/json/version` discovery is not required |

The runtime detects standard Linux, macOS, and Windows Chrome profile locations.
Use `CHROME_USER_DATA_DIR` for a nonstandard profile. The existing Chrome browser
must expose remote debugging and accept the connection.

The legacy `npm run test:browser` launches an isolated temporary **test** Chrome
profile and intercepts every retailer/provider request. It exercises the complete
web form, real adapter, secure-frame entry, one-time new/saved card submission,
outgoing request guards, budget blocking, cancellation, and mobile layout. It
cannot send a payment to BIG W or read your normal Chrome profile.

For a real-store preparation check, keep the local app running and Chrome
connected, then run:

```sh
npm run smoke -- --url "https://www.bigw.com.au/product/your-product/p/ARTICLE_NUMBER" --max-total 25.00
```

This command imports your current BIG W contact details and uses the same local
coordinator as the form. It is strictly **prepare-only**, accepts no card data,
and has no purchase flag. `npm run smoke -- --help` lists its options.

## First-version scope

This version supports one selected BIG W article at a time, standard Australian
delivery, Australian contact/billing profiles, and new or retailer-saved credit
cards. A parent product requiring a specific size/colour must use that variant's
article link. Other stores, stock monitoring, pickup, express shipping, and
multi-item shopping are outside this version.

The network investigation and implementation are documented in:

- `docs/research/2026-10-15-bigw-checkout-investigation.md`
- `docs/superpowers/specs/2026-10-15-local-checkout-design.md`
- `docs/superpowers/specs/2026-10-16-duke-extension-design.md`
- `docs/superpowers/plans/2026-10-15-local-checkout.md`
- `docs/superpowers/plans/2026-10-16-duke-extension-stage1.md`
- `docs/superpowers/plans/2026-10-16-duke-extension-stage2.md`
- `docs/superpowers/plans/2026-10-16-duke-extension-stage3.md`
- `docs/superpowers/plans/2026-10-16-duke-extension-stage4.md`

Controlled browser tests do not establish live issuer authorization or charging
behavior. No real card purchase was part of development verification.
