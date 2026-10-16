import { describe, expect, it } from 'vitest';
import { isBlockedThirdParty, TrafficPolicy } from '../src/server/browser/blocklist.ts';

describe('third-party traffic policy', () => {
  it('blocks advertising, analytics, and experimentation hosts', () => {
    for (const url of [
      'https://www.google-analytics.com/g/collect',
      'https://analytics.tiktok.com/api/v2/pixel',
      'https://connect.facebook.net/en_US/fbevents.js',
      'https://o4506662522519552.ingest.sentry.io/api/1/envelope/',
      'https://k-aeu1.contentsquare.net/v2/recording',
      'https://logx.optimizely.com/v1/events',
      'https://recommendationv2.api.useinsider.com/v2/manual-merchandising',
      'https://8328731.fls.doubleclick.net/activityi',
      'https://c.go-mpulse.net/api/config.json',
    ]) {
      expect(isBlockedThirdParty(url), url).toBe(true);
    }
  });

  it('never blocks BIG W, the payment provider, or other payment methods', () => {
    for (const url of [
      'https://www.bigw.com.au/_next/static/chunks/pages/checkout.js',
      'https://api.bigw.com.au/storefront/v1/cart/CT_x/pay',
      'https://apix.bigw.com.au/apim/product-price-api/v1/prices/6071620',
      'https://secure-fields.wpay2.gr4vy.app/input.html?type=number',
      'https://secure-fields.wpay2.gr4vy.app/controller.html',
      'https://www.payments.woolworths.com.au/3ds/challenge',
      'https://www.paypal.com/sdk/js',
      'https://static.zip.co/widget.js',
      'https://portal.afterpay.com/afterpay.js',
    ]) {
      expect(isBlockedThirdParty(url), url).toBe(false);
    }
  });

  it('does not treat malformed or non-http values as blockable', () => {
    expect(isBlockedThirdParty('not a url')).toBe(false);
    expect(isBlockedThirdParty('data:text/html,hi')).toBe(false);
    expect(isBlockedThirdParty('about:blank')).toBe(false);
  });

  it('continues allowed requests and aborts blocked ones with priority', async () => {
    const requests: { url: string }[] = [];
    const page = { on: (_event: 'request', listener: (request: never) => void) => { listener; return page; }, setRequestInterception: async () => undefined };
    const policy = new TrafficPolicy(page as never);
    await policy.install();
    const calls: string[] = [];
    const fake = (url: string) => ({ url: () => url, abort: async () => { calls.push(`abort ${url}`); }, continue: async () => { calls.push(`continue ${url}`); } });
    const listener = (policy as unknown as { handler: (request: unknown) => void }).handler;
    await listener(fake('https://www.google-analytics.com/g/collect'));
    await listener(fake('https://www.bigw.com.au/cart'));
    expect(calls).toEqual(['abort https://www.google-analytics.com/g/collect', 'continue https://www.bigw.com.au/cart']);
    expect(policy.blockedCount).toBe(1);
    expect(requests).toBeDefined();
  });
});
