// ---------------------------------------------------------------------------
// product-url — the BIG W product-link predicate
// ---------------------------------------------------------------------------
// The single, cheap predicate shared by the service worker's trigger surface
// (triggers.ts) and the content-script hover chip (content/link-scout.ts). It
// lives in lib/ so background code can import it without pulling in a
// content-script module; link-scout re-exports it so the hover chip keeps its
// existing surface. The strict, parse-oriented check stays in
// shared/validation.ts (parseProductLink); this one is only a routing filter.
// ---------------------------------------------------------------------------

export const PRODUCT_URL = /^https?:\/\/(www\.)?bigw\.com\.au\/product\/[^/]+\/p\/\d+/;

export function isProductUrl(url: string): boolean {
  return typeof url === 'string' && PRODUCT_URL.test(url);
}
