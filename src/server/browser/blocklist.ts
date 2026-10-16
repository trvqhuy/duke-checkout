// Third-party hosts that provide advertising, analytics, experimentation, chat,
// or error-tracking only. Blocking them removes most of a BIG W page load without
// affecting checkout, addresses, pricing, or any payment flow. Hosts owned by BIG
// W, the payment provider (Gr4vy/Wpay), and other payment methods are never listed.
const BLOCKED_SUFFIXES = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'optimizely.com',
  'contentsquare.net',
  'useinsider.com',
  'rokt.com',
  'rokt-api.com',
  'medallia.com',
  'medallia.com.au',
  'kampyle.com',
  'branch.io',
  'adsrvr.org',
  'flashtalking.com',
  'go-mpulse.net',
  'creativecdn.com',
  'decibelinsight.net',
  'trendii.com',
  'mindbehind.com',
  'sentry.io',
  'clarity.ms',
  'criteo.com',
  'criteo.net',
  'hotjar.com',
  'hotjar.io',
  'bat.bing.com',
  'sc-static.net',
  'demdex.net',
  'omtrdc.net',
  'adobedtm.com',
  'tealiumiq.com',
  'quantummetric.com',
  'dynamicyield.com',
  'bazaarvoice.com',
  'yimg.com',
  'tiktok.com',
  'pinterest.com',
  'facebook.net',
  'siftscience.com',
];

const ALLOW_SUFFIXES = [
  'bigw.com.au',
  'gr4vy.app',
  'gr4vy.com',
  'payments.woolworths.com.au',
  'woolworths.com.au',
  'paypal.com',
  'paypalobjects.com',
  'zip.co',
  'zipmoney.com.au',
  'afterpay.com',
  'aftpay.com',
];

function matches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export function isBlockedThirdParty(rawUrl: string): boolean {
  let hostname: string;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    hostname = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  // An explicit allow always wins, so a blocked parent (for example a search
  // vendor) can never capture a payment or retailer host that shares it.
  if (ALLOW_SUFFIXES.some(suffix => matches(hostname, suffix))) return false;
  return BLOCKED_SUFFIXES.some(suffix => matches(hostname, suffix));
}

export interface InterceptableRequest {
  url(): string;
  abort(errorCode?: string, priority?: number): Promise<unknown>;
  continue(overrides?: Record<string, unknown>, priority?: number): Promise<unknown>;
}

// Keeps request interception enabled for the lifetime of a working tab. It
// continues everything it does not block, so page navigation and the payment
// guard (which runs at a higher priority) keep working.
export class TrafficPolicy {
  private installed = false;
  private blocked = 0;
  private readonly handler = (request: InterceptableRequest) => this.handle(request);

  constructor(private readonly page: { on(event: 'request', listener: (request: InterceptableRequest) => void): unknown; setRequestInterception(value: boolean): Promise<void> }) {}

  get blockedCount(): number { return this.blocked; }

  async install(): Promise<void> {
    if (this.installed) return;
    this.page.on('request', this.handler);
    await this.page.setRequestInterception(true);
    this.installed = true;
  }

  private async handle(request: InterceptableRequest): Promise<void> {
    if (isBlockedThirdParty(request.url())) {
      this.blocked += 1;
      await request.abort('blockedbyclient', 50).catch(() => undefined);
      return;
    }
    await request.continue({}, -100).catch(() => undefined);
  }
}
