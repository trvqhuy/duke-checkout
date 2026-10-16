# Local BIG W Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execution is inline in the current session; the user requested implementation and did not request agent delegation.

**Goal:** Build a polished local form that prepares or automatically purchases a BIG W product using the user's existing Chrome session.

**Architecture:** A loopback Express server coordinates one deterministic browser-backed run at a time. A BIG W adapter performs authenticated in-page API requests and drives the retailer's secure card fields; React consumes local APIs and server-sent progress events. Contact profiles and sanitized run history are saved atomically, while payment secrets are transient.

**Tech Stack:** Node 22, TypeScript, React, Vite, Express, Puppeteer Core, ws, Zod, libphonenumber-js, Vitest, plain CSS and self-hosted fonts.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` | Shared public models, stage names, adapter contracts. |
| `src/shared/validation.ts` | Product-link, currency, Australian profile, and payment validation. |
| `src/server/errors.ts` | Safe public operational errors. |
| `src/server/storage.ts` | Atomic private profile and sanitized-history persistence. |
| `src/server/browser/connection.ts` | Existing-Chrome discovery, bounded transport, connection lifecycle. |
| `src/server/browser/page-api.ts` | Closure-free in-page authentication and API functions. |
| `src/server/browser/bigw.ts` | Product, cart, address, fulfilment, and preparation adapter. |
| `src/server/browser/payment.ts` | Secure-field entry and merchant payment outcome observation. |
| `src/server/checkout.ts` | Run state machine, budget guards, cancellation, and recovery. |
| `src/server/app.ts` | Loopback API boundaries, SSE, profiles, and run routes. |
| `src/server/index.ts` | Development/production hosting and clean shutdown. |
| `src/client/api.ts` | Typed local API client. |
| `src/client/App.tsx` | Connected form and workflow state. |
| `src/client/components.tsx` | Profile fields, payment fields, summary, progress, and history. |
| `src/client/styles.css` | Responsive warm editorial utility design. |
| `tests/*.test.ts` | Validation, persistence, orchestration, transport discovery, and HTTP behavior. |
| `scripts/smoke.ts` | Explicit existing-browser, prepare-only integration check. |
| `README.md` | Setup, connection permission, modes, operation, and verification limits. |

## Task 1: Contracts and validated inputs

- [ ] Add package scripts, strict TypeScript, Vite, and Vitest configuration.
- [ ] Write validation tests before runtime implementation. Include a valid +61/national Australian number, an international number, non-BIG-W URLs, zero budget, fractional quantities, expired cards, Luhn failure, and prepare mode without a card.
- [ ] Run `npm test -- tests/validation.test.ts` and verify it fails because validation is absent.
- [ ] Define shared models with these discriminants:

```ts
type RunMode = 'prepare' | 'purchase';
type RunStatus = 'queued' | 'running' | 'action_required' | 'ready' | 'succeeded' | 'failed' | 'cancelled' | 'payment_unknown';
type PaymentInput = { kind: 'new'; number: string; expiry: string; cvv: string } | { kind: 'saved'; cardId: string; cvv: string };
```

- [ ] Implement validation with a canonical BIG W product URL, an integer quantity from 1 through 20, exact cents conversion, Australian phone normalization, required street/suburb/postcode/state fields, and conditional payment requirements. Profile schemas reject payment fields.
- [ ] Rerun the validation suite and require all assertions to pass.

## Task 2: Existing-browser transport and private storage

- [ ] Write discovery tests using temporary DevToolsActivePort files, including missing files, malformed ports, invalid browser paths, and an explicit WebSocket override.
- [ ] Write profile/history persistence tests that verify round trips, atomic replacement, restrictive permissions, and removal of payment values from persisted runs.
- [ ] Run `npm test -- tests/connection.test.ts tests/storage.test.ts` and observe missing-feature failures.
- [ ] Implement platform-aware Chrome profile discovery. Use `CHROME_USER_DATA_DIR` or `BROWSER_WS_ENDPOINT` when supplied. Use ws with a named client header and a bounded handshake, then attach Puppeteer through its transport interface.
- [ ] Keep the connection long-lived, report connecting/connected/error states, and disconnect the client on shutdown without closing Chrome.
- [ ] Implement private JSON storage under `DATA_DIR`, with UUID profile IDs, atomic rename, schema validation, and sanitized public run records.
- [ ] Run the two suites and a read-only connection probe. A native Chrome permission requirement must be surfaced in the UI instead of silently launching a new browser.

## Task 3: Checkout coordinator

- [ ] Write behavioral tests using a fake external-store adapter. Cover successful preparation, no payment in prepare mode, over-budget blocking, unrelated cart entries, one active run, pre-payment cancellation, a confirmed order, definite rejection, unknown payment, and restart recovery.
- [ ] Run `npm test -- tests/checkout.test.ts` and observe missing coordinator behavior.
- [ ] Implement the stages `connect`, `inspect`, `cart`, `contact`, `payment`, and `complete`. Emit public snapshots on each transition and retain no payment fields in public records.
- [ ] Require exact product/quantity matching and an authoritative total within budget immediately before submission. Mark a run as potentially submitted before invoking payment; never retry a payment automatically.
- [ ] Implement cancellation before submission and unknown-outcome resolution after an actual ambiguous result. Keep subsequent purchases of that product blocked until resolution.
- [ ] Run coordinator tests and verify call counts prove payment was not attempted on failed guards.

## Task 4: BIG W adapter and secure payment driver

- [ ] Implement the inspected API contracts inside the BIG W browser page using its current Auth0 cache and observed `authorization3` header. Request bodies and tokens must not be logged.
- [ ] Before a run, use the site's normal reload/authentication refresh when the cached token is near expiry. Report login requirements if the site cannot renew it.
- [ ] Extract product metadata and the available flag from the actual API responses; expose only sanitized product information to the form.
- [ ] Reuse an exact-match cart or create a dedicated cart. Apply location cookies, fulfilment, delivery/contact, billing, and recalculation in order. Preserve unrelated cart contents.
- [ ] Activate the resulting cart in Chrome, reload the native checkout, and wait for Gr4vy frame readiness. Verify the refreshed cart again after native initialization.
- [ ] Fill new-card fields by frame `type` through Puppeteer; fill a saved-card CVV or use the observed saved-card transaction schema when applicable. Subscribe to merchant responses before submitting.
- [ ] Recognize order references, definite failures, actual authentication redirects, and timeout/unknown outcomes. Clear transient field references when the operation settles.
- [ ] Verify the full real-browser preparation path with `npm run smoke -- --url <BIG_W_PRODUCT_URL> --max-total 25`; this command is strictly prepare-only.

## Task 5: Loopback API and event stream

- [ ] Write HTTP tests for bootstrap, profile CRUD, rejected foreign origins/hosts, missing mutation token, accepted run requests, cancellation, and secret-free run responses.
- [ ] Run `npm test -- tests/app.test.ts` and observe missing routes.
- [ ] Implement `GET /api/bootstrap`, `POST /api/browser/connect`, `POST /api/browser/import-profile`, `POST /api/inspect`, profile CRUD, run creation/cancellation/resolution, and `GET /api/events`.
- [ ] Bind to loopback, constrain JSON size, enforce Host/Origin and a per-process mutation token, and use a same-site local cookie for the event stream. Do not enable cross-origin access.
- [ ] Broadcast run and browser snapshots with SSE; clean up listeners on client disconnect. Return structured field errors without echoing input values.
- [ ] Run HTTP tests and type checks.

## Task 6: Local web form

- [ ] Build product URL inspection, quantity, delivered-budget, prepare/purchase controls, and an actual product preview.
- [ ] Build local profile selection, import-current-details, save/update/delete, and delivery/billing fields with inline errors.
- [ ] Build transient new/saved card entry with clear retailer card-saving behavior. Clear card inputs once a run is accepted; do not store them in browser storage.
- [ ] Build connection setup/status, live stage progress with timestamps, cancellation, order/ready/error states, and recent run history. Unknown payment resolution is shown only for an actual unknown result.
- [ ] Apply self-hosted DM Sans and Instrument Serif, warm bone surfaces, restrained pastel status colors, crisp borders, accessible focus and error relationships, reduced-motion support, and responsive grid stacking.
- [ ] Run `npm run build` and inspect the real app at desktop and narrow mobile sizes. Exercise invalid fields, profile import/persistence, product inspection, prepare mode, SSE progress, and cancellation.

## Task 7: Final verification and operation

- [ ] Run `npm test` and `npm run build` after the final changes.
- [ ] Run the actual BIG W preparation flow and check that the intended item, quantity, total, addresses, and secure fields are correct. Do not pass payment data to this verification.
- [ ] Review the code for secret retention, unsafe retries, stale cart assumptions, unrelated cart modification, unbounded waits, and connection teardown that could close Chrome.
- [ ] Document tested behavior, setup commands, existing-browser permission, persistent data location, and unexercised live-charge behavior in `README.md`.

## Self-review

The plan covers all approved form, browser, checkout, recovery, persistence, and
verification requirements. The only external setup dependency is Chrome accepting
the app's separate connection. A direct charge is outside development verification;
the purchase path is implemented and tested against controlled adapters and payment
fixtures, with live preparation proving the real store integration.
