# Duke Checkout

A small local web app for preparing or purchasing a **BIG W Australia** product
using your existing Chrome session. It uses direct browser-context requests for
checkout preparation, then BIG W's own Gr4vy/Wpay secure fields for a new card.

## Start

Requires Node **22.20 or newer** and an installed Chrome browser.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4317**. For development with automatic reloads:

```sh
npm run dev
```

### Connect your existing Chrome

1. In that Chrome browser, open `chrome://inspect/#remote-debugging` and enable
   **Allow remote debugging for this browser instance**.
2. Keep a BIG W tab open and sign in to your account.
3. Click **Connect Chrome** in Duke. Allow **Duke Checkout** in Chrome's native
   connection prompt if one appears.

Duke attaches to Chrome; it does not launch a separate shopping browser. Stopping
the app disconnects its automation client without closing Chrome. A connection
already granted to Chrome DevTools MCP does not automatically grant a separate
connection to this app.

## Use the form

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

### What the engine checks

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

Preparation happens in a dedicated **background tab** on a lightweight BIG W
same-origin document (no app code, no analytics). All API work runs there, and
the tab is only navigated to the checkout step and brought to the front **at the
very end** — so you don't watch each step. While the cart is being prepared, the
checkout route's own assets are prefetched into the browser cache, so the final
navigation's document load is ~0.8s (most assets come from cache). In **prepare
mode** the run finishes as soon as the cart is authoritative and lets BIG W's page
render on screen (measured ~7–9s end to end); in **purchase mode** it additionally
waits for the secure card fields, because it fills them next. When the BIG W
session token needs renewing, the working tab briefly loads the product page
instead, because only the site's own SDK can silently refresh it. Third-party
advertising, analytics, and experimentation hosts are blocked during our page
loads; BIG W, the Gr4vy/Wpay payment fields, and other payment providers are never
blocked. Transient read failures are retried a couple of times automatically.
Independent reads overlap; cart mutations are serialized. There are no model
decisions between checkout steps and no arbitrary UI sleeps.

The native checkout page is loaded for the payment step, which also ends any
payment-SDK callbacks left from a previous run.

## Outcomes and recovery

An order is marked confirmed when the observed merchant transaction supplies an
order reference. An explicit rejection is distinct from an unknown network
outcome. Payment submissions are **not automatically retried**.

When an outcome is unknown it is recorded on the run; it does **not** block later
purchases. Check BIG W's order history and, if you want, use the run's resolution
controls to record the order reference or mark it as checked/not placed.
Interrupted post-submission runs recover as unknown after restarting the app.
Purchase records are retained independently of the recent-preparation history
limit.

## Trigger threat model

The extension's one-click surfaces are built so a web page cannot spend on the
user's behalf:

- **One-click spending needs a real user gesture.** The hover chip only appears
  after a *trusted* `mouseover` from the browser's own pointer, and its buttons
  only act on *trusted* clicks. Events a page script synthesizes with
  `dispatchEvent`/`element.click()` are ignored, so a hostile page cannot move
  the user's intent onto a purchase. The chip's shadow root is `open` (so tests
  can read its geometry), but `isTrusted` — not the shadow boundary — is the
  gate.
- **`confirmBeforePay` forces a review step.** With it on, a trigger never
  starts a purchase directly; the app opens with the product so the user presses
  the final button.
- **The session card is opt-in and ephemeral.** A card is only remembered when
  the user ticks the remember checkbox, and it lives solely in
  `chrome.storage.session` — never in profiles, history, or `storage.local` — so
  it is wiped when the browser session ends.
- **Auto-arm is rate-limited.** Auto-arm skips while a run is in flight and
  fires at most once per 5 s across all tabs, bounding retailer API calls.

For a shared or less-trusted machine, the recommended settings are:
leave the **Remember this card** checkbox unticked (so one-click runs prompt for
the card each time), enable **Ask before submitting payment**, and disable
**auto-arm** and the **hover chip**.

## Local data and configuration

The app listens on `127.0.0.1` and checks local Host/Origin and request tokens.
Contact profiles and sanitized run records are stored in `data/` using private
file permissions and atomic writes. That directory is git-ignored. Card details,
security codes, browser tokens, raw network bodies, and address values in run
history are excluded from persistence.

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

## Verification commands

```sh
npm test
npm run build
npm run test:browser
```

`test:browser` launches an isolated temporary **test** Chrome profile. Every
retailer/provider request is intercepted. It exercises the complete web form,
real adapter, secure-frame entry, one-time new/saved card submission, outgoing
request guards, budget blocking, cancellation, and mobile layout. It cannot send
a payment to BIG W or read your normal Chrome profile.

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
- `docs/superpowers/plans/2026-10-15-local-checkout.md`

Controlled browser tests do not establish live issuer authorization or charging
behavior. No real card purchase was part of development verification.
