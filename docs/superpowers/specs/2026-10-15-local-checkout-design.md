# Local BIG W checkout app

## Approval and scope

The user approved the API-first hybrid approach and a small local web form, then
requested implementation on 2026-10-15. This specification records that approved
direction. The first store adapter is BIG W Australia. The app purchases a
specified product and quantity immediately; stock watching and other stores are
outside this version.

## Experience

A locally served, responsive form collects a product link, quantity, maximum
delivered total, reusable delivery/contact profile, billing preference, and
payment details. A product inspection shows the actual product, availability,
price, and estimated delivery cost. Users can import their current BIG W contact
details. Contact profiles can be saved locally; payment secrets cannot.

Two explicit execution modes are available in the initial form: prepare checkout
and purchase automatically. Prepare mode stops at the ready payment form and
does not require a card. Purchase mode validates payment inputs upfront and runs
through submission without another confirmation dialog. Issuer authentication,
when requested, is completed in the existing Chrome tab. The web form shows
connection state, stage progress, elapsed times, outcome, and recent runs.

The visual direction is warm, flat, editorial utility: restrained borders,
generous spacing, strong labels, serif display text, self-hosted fonts, and muted
semantic status colors. The desktop layout pairs the form with a sticky run
summary; the mobile layout is a single column. Inputs have visible labels,
keyboard focus, associated errors, and appropriate autocomplete metadata.

## Architecture

- A Node/TypeScript loopback server hosts the React/Vite app, local JSON storage,
  the browser connector, and a single-run checkout coordinator.
- A long-lived Puppeteer connection attaches to the existing Chrome instance.
  It discovers the browser WebSocket from Chrome's DevToolsActivePort file, with
  explicit environment overrides. Connection is bounded and disconnecting the
  app never closes the user's browser. Chrome's native permission prompt remains
  part of connection setup when required.
- The BIG W adapter performs authenticated API calls inside the BIG W page,
  keeping browser credentials in that page. It uses the observed API schemas and
  current authentication header. Normal site reload/authentication refresh runs
  before the critical sequence when credentials are near expiry.
- Cart, address, stock, total, and version handling are separate from the run
  state machine and HTTP layer. The payment driver locates Gr4vy frames by field
  type and fills them through browser automation.
- Server-sent events deliver progress updates. Public run records contain no
  request bodies, tokens, address values, card numbers, expiry dates, or CVVs.

## Checkout sequence

1. Validate the URL, quantity, spending limit, profile, and requested payment mode.
2. Attach Chrome, identify a BIG W tab, and verify an authenticated session.
3. Read product details, price, location, and availability. Interpret preorder
   availability by its available flag, not a zero quantity alone.
4. Reuse a cart only if its entries exactly match the requested product and
   quantity. Otherwise create a dedicated cart without clearing unrelated items.
5. Apply fulfilment, delivery/contact details, and billing details sequentially;
   recalculate and validate the authoritative cart total and contents.
6. Activate that cart in the existing BIG W page and wait for the actual secure
   fields, rather than a presumed payment URL or a fixed sleep.
7. In prepare mode, return the ready state. In purchase mode, fill the selected
   payment method, recheck cart contents and delivered total, and submit once.
8. Observe BIG W's payment response and confirmation, surface a genuine bank
   challenge, and report an order reference only when it is obtained from the
   merchant. An ambiguous post-submission outcome is recorded as unknown.

Independent product/price reads may overlap. Cart mutations are serialized.
Authenticated credentials and cart versions are resolved freshly. Payment
submissions have no automatic retry. An unresolved payment prevents another
purchase of the same product until its outcome is checked and explicitly
resolved in the app. This recovery action is available only after an actual
ambiguous result, not as an extra step in ordinary purchases.

## Inputs and persistence

Profiles contain a name, recipient, Australian delivery phone, Australian
delivery address, and optional separate Australian billing address. Phone
normalization accepts national and +61 formats. The site's account provides the
checkout email. Profiles and sanitized run history use atomic writes and private
file permissions in an ignored data directory. The app serves on loopback only
and checks Host, Origin, and a per-process request token on mutations.

New-card inputs are card number, expiry, and CVV. A saved retailer card can be
selected when available, with a CVV for this run. Payment values exist only in
transient request/run memory and the payment fields; they are excluded from
history and profile persistence. The current native BIG W new-card handler
saves a card to the retailer account; the form states that behavior.

## Failure and cancellation behavior

Validation errors stay associated with their fields. Missing login, browser
permission, unavailable products, changed cart contents, and spending-limit
violations have actionable messages. Reads have bounded timeouts. Cancellation
stops a run before submission; after submission the app waits for the payment
outcome rather than claiming cancellation can undo a payment. Interrupted runs
that may have submitted payment are marked unknown on restart. Definite payment
rejection is distinct from an ambiguous network outcome.

## Verification

Meaningful automated tests cover input validation, private profile persistence,
budget/content guards, single-run exclusion, cancellation, secret-free run
records, and payment-outcome recovery. HTTP tests cover local request boundaries
and form/API behavior. Browser checks cover responsive layout and form errors.
Live verification uses the actual signed-in BIG W session in prepare mode. No
live payment is part of development verification without a separately supplied
real payment method and instruction to purchase.

## Revision 2026-10-16: faster, quieter preparation

User feedback: the flow should not surface a tab per step, should reveal the
checkout only at the very end, and should send as little network as possible.

- The working tab is a **dedicated background tab** on a lightweight same-origin
  document. It stays unfocused during preparation and is only navigated to the
  checkout step and brought forward at the end.
- The previous `/cart` navigation is removed. Preparation is API-only.
- **Third-party advertising, analytics, and experimentation hosts are blocked**
  during our controlled loads. Payment (Gr4vy/Wpay), other payment providers, and
  BIG W's own hosts are never blocked. Measured: a checkout load fell from ~174
  requests (52 third-party) to ~134 requests with 28 third-party aborted and
  ~1 KB of external transfer.
- The BIG W session token can only be renewed by the site's own SDK, so when the
  token is stale the working tab briefly loads the product page; otherwise it
  stays on the light document. Consecutive runs within the token window stay
  light.
- The local request token is persisted per install so a server restart does not
  strand an open browser tab; the client also resynchronises via SSE.
- The checkout route's own assets are **prefetched into the browser cache** while
  the cart is prepared, so the single visible navigation's document load is fast
  (measured ~0.8s, most assets from cache). The remaining reveal time is BIG W's
  own post-load cart calls and the Gr4vy SDK, which cannot be prefetched away.
- The working tab carries a per-tab marker so restarts reuse one tab instead of
  accumulating tabs.
- **Prepare mode does not wait for BIG W's checkout to finish rendering.** Once the
  cart is authoritative it reveals the tab and reports ready, letting the page
  render on screen; the run's own `verify` still reads the cart back and checks
  the product/quantity/total/address before reporting ready. Purchase mode keeps
  waiting for the secure fields because it fills them. Measured prepare runs fell
  from ~13–16s to ~7–9s.
- **The checkout rebuilds the Gr4vy secure card iframes several times while it
  settles after load** (observed three rounds of `controller.html` + three
  `input.html` reloads), discarding anything typed into an earlier generation.
  Card filling therefore fills, reads each field back, and re-fills until the
  values persist; a bounded number of passes covers the churn. This is why a
  freshly filled card could appear to be wiped by a page "refresh".
