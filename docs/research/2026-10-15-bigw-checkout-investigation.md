# BIG W checkout investigation

Date: 2026-10-15

## Scope and outcome

Inspected BIG W in the user's existing Chrome session through delivery submission,
checkout-session creation, and readiness of the live credit-card form. Reviewed
the public JavaScript client to identify the subsequent payment sequence.

The investigated product is article `6071620`, a delivery-only book preorder.
The observed cart contains one item at A$18 plus A$4 delivery, totaling A$22.
These are observations for this product, destination region, and session; they
are not general shipping or pricing rules.

The pre-payment flow is verified. Card autofill, vaulting, payment authorization,
order creation, and issuer authentication have not been exercised. No Pay
button was clicked during this investigation.

This document contains no customer contact details, address values, credentials,
card data, cart identifiers, checkout-session identifiers, or browser WebSocket
identifiers. Braced identifiers below describe URL parameters, not captured
session values.

## Live observations

- Checkout initially redirected to BIG W's sign-in page. The user signed in in
  the existing browser, and checkout subsequently worked in that session.
- The account initially had no saved delivery addresses or cards. The user added
  a delivery address and selected billing equal to delivery during investigation.
- The international account phone number was rejected by checkout's Australian
  phone validation. An Australian number in `+61` format was subsequently accepted.
  The displayed error referred to a valid 10-digit Australian number; the accepted
  value demonstrates that formatting and normalization matter.
- Standard delivery was available for this preorder; pickup, same-day delivery,
  and express delivery were unavailable in the investigated region.
- Product availability reported standard delivery `available: true` together
  with `quantity: 0`. A preorder must not be classified as unavailable solely
  because its quantity field is zero.
- Continuing to payment changed the checkout's visible state while the URL
  remained `/checkout/delivery`. Waiting for a `/checkout/payment` navigation
  would not correctly detect readiness in this flow.
- The final read-only cart verification returned HTTP 200, version 24, both
  delivery and billing addresses present, customer present, one unit of the
  intended product, total `2200`, and `validation.isValid: true`.

## Observed network interfaces

The following live requests returned HTTP 200. Unless otherwise noted, paths
use the origin `https://api.bigw.com.au`.

| Operation | Method and path | Notes |
| --- | --- | --- |
| Product price | `GET https://apix.bigw.com.au/apim/product-price-api/v1/prices/{productCode}?state={state}` | Amounts are represented in cents. |
| Product availability | `GET /api/availability/v0/product/{productCode}` | Depends on store and delivery location. |
| Create cart and add item | `POST /storefront/v1/cart/create` | Observed payload includes product, quantity, location, store, and sales channel. |
| Merge after login | `POST /storefront/v1/cart/{cartId}/merge?channel=web` | The native site performed this after sign-in. |
| Read cart | `GET /storefront/v1/cart/{cartId}?state={state}&channel=web` | Includes version, prices, customer, addresses, and validation. |
| Fulfilment preference | `POST /storefront/v1/cart/{cartId}/fulfilment-preference?channel=web` | Native cart/checkout initialization. |
| Cart availability | `GET /storefront/v1/cart/{cartId}/availability` | Includes location and nearby store parameters. |
| Save profile address | `POST /profile/v1/addresses` | Observed when the user added their address. |
| Delivery/contact details | `POST /storefront/v1/cart/{cartId}/update-details?channel=web` | Succeeded after Australian phone validation. |
| Billing details | `POST /storefront/v1/cart/{cartId}/billing-address?channel=web` | Followed delivery/contact submission. |
| Recalculate | `POST /storefront/v1/cart/{cartId}/recalculate?channel=web` | Observed before the card session was created. |
| Payment options | `GET /storefront/v1/cart/{cartId}/payment-options` | Card is represented by the option type `webpay`. |
| Saved cards | `GET /storefront/v1/cart/saved-cards` | Returned an empty list in this session. |
| Create card checkout session | `POST /storefront/v1/cart/{cartId}/checkout-sessions` | Returned a checkout-session identifier. |

The captured create-cart request used this schema:

```json
{
  "storeId": "{storeId}",
  "postcode": "{postcode}",
  "suburb": "{suburb}",
  "state": "{state}",
  "productCode": "{productCode}",
  "quantity": 1,
  "salesChannel": "website"
}
```

The captured card-session request used this schema:

```json
{
  "totalAmount": "{totalInCents}",
  "cartId": "{cartId}"
}
```

The observed native card-session request used the bearer-token header
`authorization3`. A final read-only cart request using that header also succeeded.
Earlier read-only probes using `authorization` succeeded as well, but this does
not establish that the headers are interchangeable for all operations. An
adapter should follow the active site's authentication behavior for each API.

## Payment integration

### Verified in the live page

The new-card form uses Gr4vy/Wpay in production:

- Origin: `https://secure-fields.wpay2.gr4vy.app`.
- Three `input.html` frames, identified by `type=number`, `type=expiryDate`, and
  `type=securityCode`.
- A separate secure-controller frame associated with the checkout session.
- Accessible input labels: Card number, Expiry date, Security code.
- A credit-card Pay button displaying the current total.

The card form does not show a cardholder-name field in the observed flow.
Frame existence and accessible fields were inspected; entering or tokenizing
card data was not tested.

### Identified in the shipped client; not executed

The active new-card component follows this sequence:

1. Obtain a checkout session for the cart and remaining amount.
2. Initialize Gr4vy secure fields with that session.
3. Submit the secure fields through the provider SDK.
4. On successful vaulting, call BIG W's payment service with the cart ID, current
   cart version, the initialized browser fingerprint, and transaction data.
5. Process an order number or an approval/redirect URL from the response.

The client defines `POST /storefront/v1/cart/{cartId}/pay`. Its new-card
transaction data includes `amountInCents`, `sessionId`, and
`storePaymentMethod: true`. The last setting is the site's current new-card
handler behavior, not a card-storage preference selected for a future bot.

The saved-card component uses an internal payment-method identifier and still
requires a CVV. It has not been tested with a saved card.

The bundle also defines `/pay/finalize`, other checkout implementations, and
other payment providers. Their presence alone does not establish which
finalization path will be exercised for a particular card or issuer challenge.

## Authentication and browser connection

- Auth0 access-token refresh was observed during normal checkout. One captured
  access token had a 600-second lifetime. The client supports silent refresh and
  authentication escalation when required.
- Browser-local access credentials were used in memory for read-only probes.
  Token values and cookie values are not included in this document.
- The working Chrome DevTools MCP process uses `--autoConnect` to the existing
  browser. Its installed connection implementation delegates to Puppeteer.
- A standalone connection has not been validated: conventional HTTP
  `/json/version` discovery on the advertised local Chrome port returned 404,
  and a direct browser-WebSocket handshake probe timed out. Chrome was confirmed
  to own the listening port. The reason for the independent handshake failure
  was not established. Do not assume generic HTTP CDP discovery will work merely
  because the current MCP connection works.

## Timing evidence

Individual read-only probes in the existing browser measured:

| Request | Observed elapsed time |
| --- | --- |
| Cart read before address submission | 459 ms |
| Payment-option discovery | 291 ms |
| Final configured-cart read | 513 ms |

The native checkout-session response reported server timings of approximately
58 ms at the edge and 269 ms at origin. These are server-reported components,
not an end-to-end elapsed-time measurement.

These samples establish that direct browser-context API access works. They do
not benchmark complete checkout, card vaulting, authorization, or order creation.
The page's resource-timing buffer filled during analysis, so it did not retain
all later requests. Runtime timing should collect network events from the start
of a run rather than assume the default resource buffer contains the whole flow.

## Recommended direction for design discussion

An API-first hybrid is the strongest candidate:

- Reuse the existing authenticated Chrome session and its normal token refresh.
- Collect product URL, quantity, spending limit, contact/address selection, and
  payment inputs before the speed-critical sequence.
- Validate location and Australian phone information upfront.
- Run independent reads concurrently; serialize cart mutations and use their
  returned state and version.
- Apply delivery and billing details, recalculate, and use the authoritative
  total for payment-session creation.
- Use the provider's secure fields and normal submit flow for a new card.
- Run deterministic automation without model decisions between individual
  checkout steps. Chrome DevTools MCP remains useful for inspection and debugging.
- Use condition-based readiness checks rather than fixed sleeps or a presumed
  payment URL change.
- Reconcile uncertain payment outcomes before another submission. The presence
  of a client-side cart version does not prove a server-side idempotency contract.
- Keep local payment secrets out of logs and saved profiles; collect the CVV for
  the current run. Retailer-side card saving behavior needs an explicit design
  decision based on the observed handler.
- Handle an issuer authentication challenge if one occurs. Whether a particular
  purchase can complete without that interaction cannot be established from
  the pre-payment inspection.

The initial interactive interface, standalone attachment mechanism, card-storage
behavior, and acceptable run controls remain design decisions. This investigation
is not an approved implementation specification.

## Live implementation findings (2026-10-16)

Verified while building the local app against the real, signed-in store:

- **Browser connection approval.** Chrome 144+ pauses a new external debugging
  client at the WebSocket handshake until a human approves it in the browser
  window. The app's separate connection is distinct from the Chrome DevTools MCP
  connection and must be approved on its own; the app surfaces a clear message and
  times out otherwise.
- **Call origin matters (bot protection).** Running the same-origin API requests
  from a real BIG W app page succeeds reliably, while running them from a
  non-app document (`robots.txt`) produced intermittent
  `net::ERR_HTTP2_PROTOCOL_ERROR` on `api.bigw.com.au`. The implementation now
  prepares from a real app page.
- **Avoid the `optly-user` header.** Adding an `optly-user` request header (mimicked
  from the Next.js data) forces a CORS preflight that BIG W's edge rejected in
  testing, surfacing as `TypeError: Failed to fetch`. Requests succeed without it.
- **The standalone availability endpoint is flaky.** `GET
  /api/availability/v0/product/{code}` intermittently returns HTTP/2 protocol
  errors even without custom headers, and independently of the working
  `warehouse-customer` endpoint on the same host. Treat it as advisory: the cart's
  fulfilment response is authoritative, and a failure defers rather than blocks.
- **HTTP/2 connection resets look like network failures.** Several endpoints could
  fail together for a short window and then recover, consistent with connection-
  level resets rather than per-endpoint rules. Short bounded retries help.
- **Direct `curl` is fingerprinted and rejected** (`status=000`, immediate reset)
  for `bigw.com.au` hosts while the browser succeeds, so shell probes are not a
  valid indicator of store reachability.

These findings were validated by repeated end-to-end live preparation runs that
reached the ready payment step without submitting payment.
