import type { ArmedCheckout, CartState, PreparedCheckout, ProductInfo, Profile, RunRequest, StageReporter } from '../../../shared/types.ts';
import type { PaymentBinding } from '../../../shared/payment-check.ts';

// A live bridge into a BIG W work tab: switched off by the retailer adapter;
// the extension's own message sender. `driver` is the Stage-2 checkout
// capability the service worker builds for the tab (chrome-free here): it
// exposes the BIG W checkout and Gr4vy frame drivers plus the MAIN-world
// payment guard/observer. It is optional so the Stage-1 acquire sites (the
// service worker, the keeper, and the Stage-1 tests) keep compiling; every
// Stage-2 adapter method requires it and raises BROWSER_ATTENTION without it.
export interface DriverFrame { frameId: number; url: string; type?: string }
export interface ObservedEntry { url: string; method: string; status: number; bodyText: string }
// A MAIN-world guard event forwarded by the relay: `sent` means a payment
// request actually left, `prevented` means the guard blocked it before the
// network, and `at` is when the service worker recorded it (used to ignore
// events from a previous submission).
export interface GuardEventRecord { type: string; code?: string; at: number }
export interface DriverHandle {
  frames(): Promise<DriverFrame[]>;
  sendTop(message: unknown): Promise<unknown>;
  sendFrame(frameId: number, message: unknown): Promise<unknown>;
  navigate(url: string): Promise<void>;
  // Navigates the run's presentation tab (the progress page opened by the
  // trigger) when one is supplied, otherwise opens a new active tab. Returns
  // the tab the handle now drives, so later steps stay on this run's checkout
  // instead of re-picking whichever BIG W tab happens to be first.
  openCheckoutTab(url: string, opts?: { tabId?: number }): Promise<number>;
  activate(): Promise<void>;
  url(): Promise<string>;
  observe(): Promise<{ entries: ObservedEntry[] }>;
  // Optional: drops the observer's ring buffer. The adapter clears it before a
  // submission so a stale entry from a previous run cannot settle this one.
  observeClear?(): Promise<void>;
  guardEnable(binding: PaymentBinding): Promise<void>;
  guardDisable(): Promise<void>;
  // Advisory MAIN-world guard events for this tab (newest-last, bounded). The
  // adapter filters them by the time it enabled the guard; a `prevented` event
  // with no `sent` event means the submission never reached the network.
  guardEvents(): Promise<GuardEventRecord[]>;
  antiFraud(): Promise<{ fingerprint: string }>;
}
export interface BridgeHandle { tabId: number; sender: { sendMessage: (tabId: number, msg: unknown) => Promise<unknown> }; driver?: DriverHandle }

// Extension-side retailer boundary. Unlike the server's StoreAdapter, steps
// are acquire-based: each method starts from a bridge handle produced by the
// adapter's acquire callback (SW wires acquireWorkTab + waitForBridgeReady),
// because there is no long-lived Page object to keep around.
export interface RetailerAdapter {
  readonly urlPattern: RegExp;
  inspect(productUrl: string, profile: Profile): Promise<ProductInfo>;
  prepareCart(input: RunRequest, product: ProductInfo, report: StageReporter, signal: AbortSignal): Promise<PreparedCheckout>;
  arm(input: RunRequest, report: StageReporter, signal: AbortSignal): Promise<ArmedCheckout>;
  verify(prepared: PreparedCheckout, input: RunRequest): Promise<CartState>;
}
