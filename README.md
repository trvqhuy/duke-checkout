# Duke Checkout

**One-click BIG W checkout, running entirely inside your own Chrome.**

Duke is a Chrome extension that turns a BIG W product link into a prepared — or
completed — order using the BIG W account you are already signed in to. It builds
the cart, fills your delivery and contact details, and drives BIG W's own
checkout. There is no server, no second browser, no account to create, and no
data sent anywhere except to BIG W and its payment providers.

> **Unofficial personal project.** Not affiliated with, endorsed by, or supported
> by BIG W. Use it with your own account and at your own risk; automated
> checkout may be restricted by the retailer's terms.

**Status:** Stages 1–4 are shipped — settings/inspect/arm, guarded checkout runs,
the trigger/onboarding surface, and the signed CRX release. Stage 5 rebuilt the
one-click experience: a progress tab that becomes the checkout, a quantity-aware
hover card with inline badges, an encrypted device card vault, and an autosaving
setup page.

---

## What it does

- **Hover and click.** A small "Duke" badge appears next to BIG W product links
  on any page. Hover it for a quantity stepper and **Checkout now**.
- **No form filling.** Duke reuses your BIG W session and saved delivery details.
- **Real checkout, not a mock.** It drives the actual BIG W cart, contact, and
  payment pages in your browser, and can submit the order for you.
- **Local by design.** At checkout, card details go into BIG W's own secure
  fields (Gr4vy/Wpay). Duke stores a card on this computer only when you save
  one, and the optional device copy is encrypted. Nothing is sent to a Duke
  server, because there isn't one.
- **Guarded.** A purchase can only be started by a real click or keypress in
  your browser, and payment is bound to the cart and total you reviewed.

### What you need

| Requirement | Details |
| --- | --- |
| Browser | Chrome or Chromium **116+** (Chrome for Testing and Chromium builds work well for unpacked installs). |
| BIG W account | Signed in to [bigw.com.au](https://www.bigw.com.au) in the same browser profile. |
| Delivery details | An Australian delivery address and contact number. Duke can import these from your BIG W account. |
| Payment | A credit/debit card, or a card already saved to your BIG W account. Afterpay is also supported. |
| Build tools | Only if you load the extension from source: Node **22.20+**. |

---

## Install

### Option A — the packaged extension (friends)

You need two things from whoever built the release:

1. `duke-checkout.crx`
2. The `update.xml` URL (only needed for auto-updates)

On **Linux, Chrome for Testing, and Chromium**, open `chrome://extensions`,
enable **Developer mode**, then drag `duke-checkout.crx` onto the page.

On **Windows and macOS**, Chrome blocks off-store `.crx` installs even in
Developer mode. The reliable path is an enterprise policy that force-installs
and auto-updates from the host:

- Policy: `ExtensionInstallForcelist`
- Value: `"<extension-id>;<update-url>"` — the extension ID is printed by the
  packer and `update-url` is the hosted `update.xml`.

Auto-updates only work for a release pack built with `DUKE_UPDATE_URL` set.
Those builds re-check the hosted `update.xml` every few hours. A local/test pack
never updates.

### Option B — load from source (developer)

```sh
npm install
npm run build:ext
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the built `dist-extension/` directory.
4. Skip to [First-time setup](#first-time-setup).

The checked-in `src/extension/manifest.json` never contains `update_url`, so an
unpacked developer build does not try to self-update.

---

## First-time setup

You only do this once. The setup page opens automatically on first install (and
from the Duke toolbar icon at any time).

1. **Sign in to BIG W.** Open [bigw.com.au](https://www.bigw.com.au) in the same
   Chrome profile and sign in. Duke uses that session; it never sees your
   password.
2. **Import your details.** On the Duke setup page, press **Import my BIG W
   profile**. Duke fills in your name, phone, and delivery address from your BIG
   W account. Check them, then let the page save.
3. **Add a card.** Enter the card number, expiry, and security code, then press
   **Save card for one-click runs**.
   - Leave **Keep this card ready on this device** ticked if you want one-click
     to work after a browser restart. The card is encrypted on disk.
   - Untick it if you would rather the card live only in memory for the current
     browser session.
4. **Finish setup.** The status panel should now show all three checks green:
   delivery & contact, payment card, and BIG W session.

The toolbar popup shows the same readiness summary, and tells you exactly what is
missing if something is not ready.

---

## Everyday use

### Hover a product link

Find a BIG W product link on any page — a search result, a deals site, a chat
message, or bigw.com.au itself. A small **Duke** badge marks the link.

1. Hover the link to open the card.
2. Use **−** / **+** to choose a quantity (1–20). The choice becomes your new
   default.
3. Press **Checkout now**.

A tab opens immediately and shows live progress: product, cart, contact, and
payment. When preparation finishes, that same tab becomes the BIG W checkout, so
you never end up with a stray progress tab. If something is missing (no card, no
profile, signed out), the card stays on screen with the reason and one action —
**Open Duke setup** or **Retry**. Duke never opens settings behind your back.

Press `Esc`, scroll, or move the pointer away to dismiss the card.

> **Checkout now can place a real order.** The default mode is *Purchase
> automatically*. Read [Before your first click](#before-your-first-click) and
> choose the mode you want.

### Use the toolbar popup

Click the Duke icon in the toolbar for a compact status panel:

- Ready / not ready, and what is still needed
- Quick toggles for the hover card, link badges, and auto-arm
- Your last run and its outcome
- A shortcut to the full settings page

### Right-click or use the keyboard

- Right-click any BIG W product link → **Duke: one-click checkout this link** or
  **Duke: arm this product**.
- Press `Alt+Shift+D` to check out the last product link you hovered.
- With auto-arm on, opening a BIG W product page arms it automatically.

### Run a checkout from the settings page

Open the Duke toolbar icon → **Open Duke settings**, or use the extension's
options page. Paste a product URL, press **Inspect** to confirm price and
availability, then press the action button. This is also where you can **Arm** a
product ahead of a release, watch live progress, and review run history.

### Arm a release

**Arm** prepares the session, product, and cart ahead of time. When the release
moment arrives, the armed run skips straight to payment. If the product cannot be
added yet, Duke reports that it is armed in **standby** and adds it at the
release moment.

---

## Before your first click

### Choose what a click does

Duke has four modes. The default is **Purchase automatically**, so set this
deliberately before you use the hover card on a product you do not want to buy.

| Mode | What happens | Card needed |
| --- | --- | --- |
| **Purchase automatically** (default) | Prepares checkout, fills the card, and submits the payment once. | Yes |
| **Fill card only** | Prepares checkout and fills the card, then waits for you to press **Pay** in the BIG W tab. | Yes |
| **Prepare checkout** | Prepares cart, delivery, contact, and billing, then stops at the payment step. | No |
| **Afterpay** | Prepares checkout and opens Afterpay for you to sign in and confirm. | No |

If you want a confirmation step but still want one-click from a link, turn on
**Fill the card but let me press Pay (no automatic submit)** under settings. The
hover card then runs *Fill card only*, so nothing is submitted until you press
Pay.

### Set a spending limit

**Maximum delivered total** is a hard ceiling on the item **plus delivery**, in
AUD. Duke refuses to proceed if the real total would exceed it. The default is
`1000.00`; change it to something you are comfortable with.

### Know what happens to your cart

BIG W keeps **one cart per account**. Duke reuses it instead of creating a second
cart (the old create endpoint is blocked by BIG W's edge):

- If the cart already contains exactly this product and quantity, Duke uses it
  as-is.
- Otherwise, with **Replace other items in my BIG W cart** on (the default),
  Duke removes the other entries and adds the requested product and quantity.
  The checkout then contains exactly what you chose.
- Turn that setting off if you would rather be stopped with `CART_NOT_EMPTY`
  than have other items removed.

Duke also refreshes the BIG W tab once if its session token has gone stale (for
example after the browser was idle), so the first click does not fail with a
sign-in error.

---

## Settings reference

All settings live on the Duke settings page and save automatically.

### Checkout defaults

| Setting | Default | What it does |
| --- | --- | --- |
| **Quantity** | `1` | Starting quantity for the hover card and manual runs (1–20). The hover card remembers your last choice. |
| **Maximum delivered total** | `1000.00` | Hard AUD ceiling for item + delivery. Duke never exceeds it. |
| **Mode** | Purchase automatically | What a run does at the payment step. See [Choose what a click does](#choose-what-a-click-does). |

### Toggles

| Toggle | Default | What it does |
| --- | --- | --- |
| **Show the checkout card when hovering a BIG W product link** | On | The hover card on any site. Turn off to disable hover entirely (right-click and the keyboard shortcut still work). |
| **Mark BIG W product links with a small "Duke" badge** | On | The inline badge next to recognised product links. Purely visual. |
| **Arm the checkout automatically after opening a product page** | On | Prepares a product page in the background when you open it. |
| **Fill the card but let me press Pay** | Off | Forces a review step; no automatic payment submission. |
| **Forget the session card after every order** | Off | Clears the in-memory card after each run. The encrypted device copy is only removed by **Forget** or by unticking the device option. |
| **Replace other items in my BIG W cart** | On | Makes the cart contain exactly the one-click product. Turn off to stop instead of replacing. |
| **Keep this card ready on this device** | On | Encrypts the card at rest so one-click survives a browser restart. Untick for session-only memory. |

Use **Forget** next to a saved card to remove both the session and encrypted
device copies and rotate the key.

---

## Your card and your data

Everything stays in your Chrome profile. There is no Duke account, no analytics,
and no third-party server.

- **Card entry uses BIG W's own secure fields** (Gr4vy/Wpay). Duke types into
  them; it does not render its own payment form.
- **The card is opt-in.** Saving a card always creates a memory-only copy in
  `chrome.storage.session`. If you leave **Keep this card ready on this device**
  ticked (the default), an encrypted copy is written to `storage.local` so
  one-click survives a browser restart. Untick it to keep the card in memory for
  the current session only.
- **Profiles and history are local and sanitized.** Run history excludes card
  data, security codes, browser tokens, raw request bodies, and address values.
- **Nothing is sent to a third party.** Requests go only to BIG W, Gr4vy/Wpay
  secure fields, and Afterpay — the origins declared in the extension manifest.
- **No local server and no Chrome DevTools Protocol connection.** The extension
  runs in your existing browser.

### On a shared or less-trusted computer

- Untick **Keep this card ready on this device** (the card then lasts only for
  the browser session).
- Turn on **Fill the card but let me press Pay**.
- Turn off **Arm the checkout automatically**.
- Turn off **Show the checkout card when hovering**.
- Press **Forget** when you are done.

### What is stored where

| Area | Key | Contents |
| --- | --- | --- |
| `chrome.storage.local` | `dukeSettings` | Quantity, maximum delivered total, mode, and toggle options (`rememberCardOnDevice`, `inlineBadges`, `replaceCart`, …). |
| `chrome.storage.local` | `dukeProfile` | Delivery/contact/billing profile. |
| `chrome.storage.local` | `dukeHistory` | Sanitized run records (retention-capped). No card data, security codes, browser tokens, raw bodies, or address values. |
| `chrome.storage.local` | `dukeCardVault` | Optional encrypted card envelope (`{ v, iv, data }`). The AES key is non-extractable and lives in the extension's IndexedDB. |
| `chrome.storage.session` | `dukeCard` | The one-run card (number, expiry, security code), while the browser session lasts and the user opted in. |
| `chrome.storage.session` | `dukeArmed` | The armed checkout (prepared cart/session). |
| `chrome.storage.session` | `dukeRunState` | The in-flight run, so a restarted service worker can recover it. |

`chrome.storage.session` is in-memory and cleared when the browser closes. The
device vault is what makes one-click survive a restart; **Forget card** deletes
the envelope and rotates the key.

---

## Troubleshooting

Duke reports errors where you are looking: in the hover card, the run tab, or the
app page. A finished run also raises a notification.

### First checks

1. **Are you signed in to BIG W?** Open `bigw.com.au` in the same Chrome profile.
2. **Is the BIG W tab healthy?** Reload it once. Duke needs its page bridge to
   attach.
3. **Is setup complete?** The popup lists anything missing — delivery details,
   a card, or the session.
4. **Is the product a variant?** A parent product that needs a size or colour
   must use that variant's own link.
5. **Is a VPN or browser check in the way?** Turn it off, complete BIG W's check
   in the tab, then retry.

### Error codes

| Code | What it means and what to do |
| --- | --- |
| `CARD_REQUIRED` | No card is available. Click **Open Duke setup**, add a card, then try again. |
| `PROFILE_REQUIRED` | Delivery/contact details are missing. Add them or use **Import from BIG W**, then retry. |
| `LOGIN_REQUIRED` | Sign in to BIG W again in the BIG W tab, then run again. |
| `BRIDGE_UNREADY` | No BIG W tab, or the page bridge did not attach. Open `bigw.com.au` once (reload the tab), then retry. |
| `BRIDGE_NO_RESPONSE` | The BIG W page bridge did not answer in time. Reload the BIG W tab and run again. |
| `PAYMENT_NOT_READY` | BIG W's payment form never appeared. Check the checkout tab for a sign-in or address prompt, fix it, then prepare a fresh run. |
| `CONTACT_REQUIRED` | BIG W rejected the contact/address step. Check the profile's delivery and billing details, then prepare again. |
| `PAYMENT_DECLINED` | BIG W rejected the payment. Check the card details and try again, or use another card. |
| `payment_unknown` | The outcome is not confirmed (a drop or timeout after submission, reported as `PAYMENT_UNKNOWN`). Check BIG W order history, then use the run's **Resolve** controls to record the order number or mark it not purchased. Do not resubmit blindly. |
| `DRIVER_TIMEOUT` | A checkout content script did not respond. Reload the checkout tab and prepare again. |

Other messages are variants of the same causes:

- `SESSION_EXPIRED` — open BIG W and sign in again.
- `BROWSER_ATTENTION` / `STORE_REQUEST` — BIG W blocked a request. Open
  `bigw.com.au` in the same Chrome, complete its browser check, turn off a VPN if
  you use one, then retry.
- `VARIANT_REQUIRED` — pick the size/colour on BIG W and use that item's link.
- `REQUEST_TIMEOUT` / `REQUEST_NETWORK` — retry the page.
- `CARD_FIELDS` / `CARD_SESSION` — secure fields were not ready; prepare a fresh
  run.
- `SAVED_CARD` — re-import the BIG W details.
- `CART_NOT_EMPTY` — turn on cart replacement or empty the BIG W cart.
- `CART_CHANGED` / `PAYMENT_CHANGED` — the guard blocked a submission because
  the cart, total, or session changed. Prepare a fresh run.

### Unknown payment outcome

An order is marked confirmed when the merchant transaction supplies an order
reference. An explicit rejection is distinct from an unknown network outcome.
Payment submissions are **never automatically retried**.

If the outcome is unknown, check BIG W's order history. Use the run's
**Resolve** controls to record the order reference or mark it as not purchased.
An unknown outcome does not block later purchases.

### Uninstall and remove data

Remove the extension from `chrome://extensions`. Its `chrome.storage` and
IndexedDB data are deleted with the extension. To wipe the encrypted card
first, press **Forget** on the settings page.

---

## How it works (for developers)

### Surfaces

The extension has four surfaces, all backed by one service worker:

| Surface | Where | What it does |
| --- | --- | --- |
| **App page** | Options page and toolbar popup (`app.html`, `app.html?popup=1`) | Readiness status, delivery/contact, payment, defaults, manual checkout, live run progress, and history. Settings and the profile autosave; the popup is a compact status panel. |
| **Hover card** | Any web page (`content/link-scout.ts`) | A small "Duke" badge next to BIG W product links. Hovering opens a card with a quantity stepper, **Checkout now**, **Arm**, and a settings shortcut. |
| **Run tab** | A new tab | Opens instantly when Checkout is clicked, shows live progress and Cancel, then navigates to the BIG W checkout **in the same tab**. |
| **Triggers** | Context menu and keyboard | Right-click a link for **Duke: one-click checkout this link** / **Duke: arm this product**; press `Alt+Shift+D` to check out the last hovered product link. Auto-arm can also arm a product page on load when enabled. |

### The one-click flow

1. Hover a BIG W product link on any page. A "Duke" badge marks the link; the
   card shows the current default quantity.
2. Adjust the quantity if needed and press **Checkout now**. The chosen quantity
   becomes the new default.
3. A tab opens immediately with live stages (product, cart, contact, payment).
   The settings page is never opened as part of this flow.
4. When the cart and contact are ready, that same tab becomes the BIG W checkout
   and the card is filled/submitted according to the mode.
5. If something is missing (no card, no profile, signed out), the card stays on
   screen with the reason and a single action (**Open Duke setup**, **Retry**).
   Duke only opens settings when you click that action.

Every checkout step — token resolution, API calls, cart/contact/payment
preparation, and payment submission — executes locally in the user's Chrome via
content scripts and the service worker. Nothing is driven through CDP, and no
checkout traffic leaves the machine except the requests to BIG W and the payment
providers listed in the manifest.

### Build and test

```sh
npm install
npm run check         # tsc --noEmit
npm run build:ext     # build dist-extension/ (runs check first)
npx vitest run        # full unit + integration suite (after build:ext)
```

The integration tests in `tests/extension/` load the built `dist-extension/` into
a fixture Chrome (`channel: 'chrome'`) and drive the real service worker, content
scripts, and app page against a fixture BIG W retailer. Build first; the suite
asserts the build exists.

### Try the hover card locally

A demo page with real BIG W product links (including a variant-suffixed link, a
long title, a non-product link, and a card inserted after two seconds) is
included:

```sh
npm run demo:chips
# open http://127.0.0.1:4321/
# or: npm run demo:chips -- --open
```

Hover a product title or image. This is only a visual test page; pressing
**Checkout now** starts a real checkout, so use a product you actually want — or
just hover.

### Repository layout

- `src/extension/manifest.json` — MV3 manifest (permissions, commands, content
  scripts).
- `src/extension/background/` — service worker: run manager, triggers, arms,
  work tab, progress tab, notifications.
- `src/extension/content/` — content scripts: the MAIN/ISOLATED BIG W page
  bridges, the checkout driver, and the hover card.
- `src/extension/app/` — the React app page (options/popup).
- `src/extension/progress/` — the dependency-free run tab that opens instantly
  and is navigated to the BIG W checkout when preparation finishes.
- `src/extension/lib/` — storage, the encrypted card vault, protocol,
  product-URL predicate, and the BIG W adapter under `lib/retailers/bigw/`.
- `src/shared/` — engine logic used by both the extension and the legacy server
  (types, validation, cart/payment guards, run history and sanitization).
- `src/server/` — **legacy** localhost app (Express + Puppeteer CDP).
- `src/client/` — **legacy** React UI; its components are also reused by the
  extension's app page.
- `tests/` — vitest unit tests; `tests/extension/` holds the fixture-Chrome
  integration harness.
- `demo/chips.html` + `scripts/chip-demo.ts` — the local hover-card demo
  (`npm run demo:chips`).

### Security model

The extension is built so a web page cannot spend on the user's behalf, and so a
run cannot submit anything the user did not set up.

#### Trigger threat model

- **One-click spending needs a real user gesture.** The hover chip only appears
  after a *trusted* `mouseover` from the browser's own pointer, and its buttons
  only act on *trusted* clicks. Events a page script synthesizes with
  `dispatchEvent`/`element.click()` are ignored, so a hostile page cannot move the
  user's intent onto a purchase. The chip's shadow root is `open` (so tests can
  read its geometry), but `isTrusted` — not the shadow boundary — is the gate.
- **`confirmBeforePay` forces a review step.** With it on, a trigger runs a
  fill-only checkout: the card is filled in the BIG W checkout and nothing is
  submitted until the user presses Pay.
- **The card is opt-in.** Saving a card always creates a memory-only copy in
  `chrome.storage.session`, which is wiped when Chrome closes. The encrypted
  device copy is controlled by **Keep this card ready on this device** (on by
  default): it is sealed with AES-GCM under a non-extractable key stored in the
  extension's IndexedDB, and only the envelope (IV + ciphertext) is written to
  `storage.local`. **Forget** removes both copies. `cardClearAfterOrder` clears
  the session copy after every order; the encrypted device copy is only removed
  by **Forget** or by unticking the device option.
- **Storage is trusted-context only.** `chrome.storage.local` and
  `chrome.storage.session` are set to `TRUSTED_CONTEXTS`, so a content script
  (the only code that shares a page with untrusted scripts) cannot read the
  profile, history, or card. The hover card receives its settings over the
  extension message channel instead.
- **Auto-arm is rate-limited.** Auto-arm skips while a run is in flight and fires
  at most once per 5 s across all tabs, bounding retailer API calls.

#### Payment submission guard

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

#### What it can and cannot do

- It **can** read the user's BIG W session token through the page bridge in the
  user's own tab, call BIG W APIs as that user, drive the checkout page (fill
  fields, click Pay/Afterpay), and store settings/profile/history locally.
- It **cannot** be triggered by a web page without a real user gesture.
- It **keeps card data only when asked**: the one-run card lives in session
  memory, and the device copy is encrypted at rest. It is never written to
  profiles, history, or logs.
- It **never sends anything to a third-party server.** Requests go only to the
  BIG W, Gr4vy/Wpay (secure fields), and Afterpay origins declared in the
  manifest's `host_permissions`.
- It runs **no local server and no CDP connection**.

### Release checklist

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
   so it must be the URL that serves the update XML. Set `CHROME_PATH` only if
   Chrome is not in a standard location.
4. Upload `release/duke-checkout.crx` and `release/update.xml` to the same
   directory that `<host>` serves.
5. Confirm the `version` in `update.xml` matches the manifest version you bumped.
6. Tell the group. Installs with a working `update_url` pick the release up
   within hours; anyone who never installed it can reinstall the `.crx`.

**Reuse the same private key forever.** The extension ID is derived from the
signing key (`./duke-extension.pem`, or `DUKE_CRX_KEY`). Regenerating it changes
the extension ID: every existing install becomes a different extension that will
never receive updates, and its settings/session state do not carry over. Keep the
`.pem` secret (anyone with it can sign an update for every install) and back it up
privately. It is git-ignored (`*.pem`).

### Legacy local app

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

#### Connect your existing Chrome (legacy)

1. In that Chrome browser, open `chrome://inspect/#remote-debugging` and enable
   **Allow remote debugging for this browser instance**.
2. Keep a BIG W tab open and sign in to your account.
3. Click **Connect Chrome** in Duke. Allow **Duke Checkout** in Chrome's native
   connection prompt if one appears.

Duke attaches to Chrome; it does not launch a separate shopping browser. Stopping
the app disconnects its automation client without closing Chrome. A connection
already granted to Chrome DevTools MCP does not automatically grant a separate
connection to this app.

#### Use the form (legacy)

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
can be refreshed and selected with their security code. Card values are never
saved in profiles or history. In **prepare** and **Afterpay** modes no card is
entered. In **fill-only** mode the card stays in BIG W's secure fields for you to
submit. In **purchase** mode the card is submitted once; BIG W's own checkout then
rebuilds its payment form (which clears the fields), so use fill-only if you want
to review or edit the card before submitting. BIG W's current new-card handler
saves a payment method to the retailer account; that behavior is stated next to
the card inputs.

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

#### What the engine checks (shared)

The extension and the legacy app run the same engine:

- The link is a secure BIG W article URL and the requested quantity is valid.
- The selected Australian delivery phone, address, and billing details are
  valid.
- Delivery availability is determined from the store's available flag, including
  preorder responses that report a zero stock quantity. If the advisory
  availability lookup is temporarily rejected by BIG W's edge, the run defers to
  the cart's authoritative fulfilment response instead of failing.
- The cart contains exactly the specified item and quantity. BIG W keeps one
  cart per account, so Duke reuses it and (when cart replacement is enabled)
  removes other entries first; turn replacement off to stop instead.
- The authoritative delivery/billing address, recipient, phone, cart version,
  and delivered total match the run's inputs.
- The outgoing payment is bound to that cart/version/amount and the current
  secure-fields session or selected saved card. Changed or additional payment
  submissions are blocked before transmission.

#### Outcomes and recovery (shared)

An order is marked confirmed when the observed merchant transaction supplies an
order reference. An explicit rejection is distinct from an unknown network
outcome. Payment submissions are **not automatically retried**.

When an outcome is unknown it is recorded on the run; it does **not** block later
purchases. Check BIG W's order history and, if you want, use the run's resolution
controls to record the order reference or mark it as checked/not placed.
Interrupted post-submission runs recover as unknown after restarting the app.
Purchase records are retained independently of the recent-preparation history
limit.

#### Local data and configuration (legacy)

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

### First-version scope

This version supports one selected BIG W article at a time, standard Australian
delivery, Australian contact/billing profiles, and new or retailer-saved credit
cards. A parent product requiring a specific size/colour must use that variant's
article link. Other stores, stock monitoring, pickup, express shipping, and
multi-item shopping are outside this version.

### Design and research notes

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

---

## Disclaimer

Duke Checkout is an independent personal project. It is not affiliated with BIG W,
Woolworths Group, Gr4vy, Wpay, or Afterpay. You are responsible for the orders you
place and for complying with the retailer's terms. Test with **Prepare checkout**
or **Fill card only** before trusting any automation with a real payment.
