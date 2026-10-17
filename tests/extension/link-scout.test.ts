// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __test, isProductUrl } from '../../src/extension/content/link-scout.ts';

const PRODUCT = 'https://www.bigw.com.au/product/x/p/6071620';

function makeAnchor(href: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.textContent = 'product';
  document.body.appendChild(anchor);
  return anchor;
}

function hover(target: Element, relatedTarget?: Element | null): void {
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true, relatedTarget: relatedTarget ?? null }));
}

function unhover(target: Element, relatedTarget?: Element | null): void {
  target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, composed: true, relatedTarget: relatedTarget ?? null }));
}

function chipButton(selector: string): HTMLElement | null {
  return __test.getShadowRoot()?.querySelector<HTMLElement>(selector) ?? null;
}

function rect(left: number, bottom: number): DOMRect {
  return { left, top: bottom - 10, bottom, right: left + 100, width: 100, height: 10, x: left, y: bottom - 10, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  __test.reset();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isProductUrl', () => {
  it('accepts absolute BIG W product URLs with and without www', () => {
    expect(isProductUrl('https://www.bigw.com.au/product/x/p/6071620')).toBe(true);
    expect(isProductUrl('https://bigw.com.au/product/x/p/6071620')).toBe(true);
    expect(isProductUrl('http://www.bigw.com.au/product/some-item/p/12345')).toBe(true);
  });

  it('rejects other retailers, the home page, missing /p/digits, and non-URLs', () => {
    expect(isProductUrl('https://www.kmart.com.au/product/x/p/6071620')).toBe(false);
    expect(isProductUrl('https://www.bigw.com.au/')).toBe(false);
    expect(isProductUrl('https://www.bigw.com.au/product/x')).toBe(false);
    expect(isProductUrl('https://www.bigw.com.au/product/x/p/abc')).toBe(false);
    expect(isProductUrl('/product/x/p/6071620')).toBe(false);
    expect(isProductUrl('not a url')).toBe(false);
    expect(isProductUrl('')).toBe(false);
  });
});

describe('hover chip', () => {
  it('shows after the delay with a labelled pill and two buttons', async () => {
    vi.useFakeTimers();
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    expect(__test.chipVisible()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(__test.chipVisible()).toBe(true);
    expect(__test.getShadowRoot()?.querySelector('.duke-chip')?.textContent).toContain('Duke');
    expect(chipButton('.duke-chip-checkout')?.textContent).toContain('Checkout now');
    expect(chipButton('.duke-chip-arm')?.textContent).toContain('Arm');
  });

  it('does not show for a non-product link', async () => {
    vi.useFakeTimers();
    const anchor = makeAnchor('https://www.bigw.com.au/');
    hover(anchor);
    await vi.advanceTimersByTimeAsync(300);
    expect(__test.chipVisible()).toBe(false);
  });

  it('re-anchors when moving between product links', async () => {
    vi.useFakeTimers();
    const first = makeAnchor(PRODUCT);
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect(10, 20));
    hover(first);
    await vi.advanceTimersByTimeAsync(200);
    const chip = __test.getShadowRoot()?.querySelector<HTMLElement>('.duke-chip');
    expect(chip?.style.left).toBe('10px');

    const second = makeAnchor('https://www.bigw.com.au/product/y/p/999');
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(rect(300, 400));
    hover(second, first);
    await vi.advanceTimersByTimeAsync(200);
    expect(__test.chipVisible()).toBe(true);
    expect(chip?.style.left).toBe('300px');
  });
});

describe('dismissal', () => {
  it('hides on mouseout that leaves the anchor and chip', async () => {
    vi.useFakeTimers();
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    await vi.advanceTimersByTimeAsync(200);
    expect(__test.chipVisible()).toBe(true);
    unhover(anchor, document.body);
    await vi.advanceTimersByTimeAsync(200);
    expect(__test.chipVisible()).toBe(false);
  });

  it('stays visible when moving from the anchor into the chip', async () => {
    vi.useFakeTimers();
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    await vi.advanceTimersByTimeAsync(200);
    const chip = __test.getShadowRoot()?.querySelector<HTMLElement>('.duke-chip');
    unhover(anchor, chip);
    await vi.advanceTimersByTimeAsync(200);
    expect(__test.chipVisible()).toBe(true);
  });

  it('hides on Escape', async () => {
    vi.useFakeTimers();
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    await vi.advanceTimersByTimeAsync(200);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(__test.chipVisible()).toBe(false);
  });

  it('hides on scroll', async () => {
    vi.useFakeTimers();
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    await vi.advanceTimersByTimeAsync(200);
    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(__test.chipVisible()).toBe(false);
  });
});

describe('triggers', () => {
  it('sends trigger.checkout once and hides on Checkout now', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension', sendMessage } });
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    await vi.advanceTimersByTimeAsync(200);
    chipButton('.duke-chip-checkout')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'trigger.checkout', url: PRODUCT });
    expect(__test.chipVisible()).toBe(false);
  });

  it('sends trigger.arm once and hides on Arm', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension', sendMessage } });
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    await vi.advanceTimersByTimeAsync(200);
    chipButton('.duke-chip-arm')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'trigger.arm', url: PRODUCT });
    expect(__test.chipVisible()).toBe(false);
  });

  it('does not send when the runtime id is unavailable', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', { runtime: { id: undefined, sendMessage } });
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    await vi.advanceTimersByTimeAsync(200);
    chipButton('.duke-chip-checkout')?.click();
    chipButton('.duke-chip-arm')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('feature gate', () => {
  it('shows no chip when hoverChip is false in storage', async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => ({ dukeSettings: { hoverChip: false } }));
    vi.stubGlobal('chrome', { storage: { local: { get } } });
    __test.reset();
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    await vi.advanceTimersByTimeAsync(200);
    expect(get).toHaveBeenCalledWith(['dukeSettings']);
    expect(__test.chipVisible()).toBe(false);
  });

  it('honours a direct setSettings override', async () => {
    vi.useFakeTimers();
    __test.setSettings({ hoverChip: false });
    const anchor = makeAnchor(PRODUCT);
    hover(anchor);
    await vi.advanceTimersByTimeAsync(200);
    expect(__test.chipVisible()).toBe(false);
  });
});
