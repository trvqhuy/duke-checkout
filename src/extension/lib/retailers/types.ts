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
export interface DriverHandle {
  frames(): Promise<DriverFrame[]>;
  sendTop(message: unknown): Promise<unknown>;
  sendFrame(frameId: number, message: unknown): Promise<unknown>;
  navigate(url: string): Promise<void>;
  activate(): Promise<void>;
  url(): Promise<string>;
  observe(): Promise<{ entries: ObservedEntry[] }>;
  // Optional: drops the observer's ring buffer. The adapter clears it before a
  // submission so a stale entry from a previous run cannot settle this one.
  observeClear?(): Promise<void>;
  guardEnable(binding: PaymentBinding): Promise<void>;
  guardDisable(): Promise<void>;
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
