import type { ArmedCheckout, CartState, PreparedCheckout, ProductInfo, Profile, RunRequest, StageReporter } from '../../../shared/types.ts';

// A live bridge into a BIG W work tab: switched off by the retailer adapter;
// the extension's own message sender.
export interface BridgeHandle { tabId: number; sender: { sendMessage: (tabId: number, msg: unknown) => Promise<unknown> } }

// Extension-side retailer boundary. Unlike the server's StoreAdapter, steps
// are acquire-based: each method starts from a bridge handle produced by the
// adapter's acquire callback (SW wires acquireWorkTab + waitForBridgeReady),
// because there is no long-lived Page object to keep around.
export interface RetailerAdapter {
  urlPattern: RegExp;
  inspect(productUrl: string, profile: Profile): Promise<ProductInfo>;
  prepareCart(input: RunRequest, product: ProductInfo, report: StageReporter, signal: AbortSignal): Promise<PreparedCheckout>;
  arm(input: RunRequest, report: StageReporter, signal: AbortSignal): Promise<ArmedCheckout>;
  verify(prepared: PreparedCheckout, input: RunRequest): Promise<CartState>;
}
