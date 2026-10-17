// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, isCheckoutFrame, isFieldFrame, notifyFieldsChanged, observeRebuilds, onMessage } from '../../src/extension/content/checkout-driver.ts';

function setLocation(url: string): void {
  Object.defineProperty(window, 'location', { value: new URL(url), configurable: true, writable: true });
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  delete (document.body as unknown as { innerText?: string }).innerText;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('frame identification', () => {
  it('isFieldFrame is true only for the Gr4vy input document', () => {
    setLocation('https://secure-fields.wpay2.gr4vy.app/input.html?type=number');
    expect(isFieldFrame()).toBe(true);
    setLocation('https://secure-fields.wpay2.gr4vy.app/other.html');
    expect(isFieldFrame()).toBe(false);
    setLocation('https://www.bigw.com.au/checkout/delivery');
    expect(isFieldFrame()).toBe(false);
  });

  it('isCheckoutFrame is true only for the BIG W /checkout/ route', () => {
    setLocation('https://www.bigw.com.au/checkout/delivery');
    expect(isCheckoutFrame()).toBe(true);
    setLocation('https://www.bigw.com.au/');
    expect(isCheckoutFrame()).toBe(false);
    setLocation('https://secure-fields.wpay2.gr4vy.app/input.html');
    expect(isCheckoutFrame()).toBe(false);
  });
});

describe('field frames', () => {
  beforeEach(() => setLocation('https://secure-fields.wpay2.gr4vy.app/input.html?type=number'));

  it('set writes the value, dispatches bubbling input+change, and reads it back; get reads it; clear empties it', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const seen: string[] = [];
    document.body.addEventListener('input', event => seen.push(event.type));
    document.body.addEventListener('change', event => seen.push(event.type));

    const set = handle({ type: 'driver.field.set', value: '4242424242424242' });
    expect(set).toEqual({ value: '4242424242424242' });
    expect(input.value).toBe('4242424242424242');
    expect(seen).toEqual(['input', 'change']);

    expect(handle({ type: 'driver.field.get' })).toEqual({ value: '4242424242424242' });

    const cleared = handle({ type: 'driver.field.clear' });
    expect(cleared).toEqual({ value: '' });
    expect(input.value).toBe('');
    expect(seen).toEqual(['input', 'change', 'input', 'change']);
  });

  it('get reports an empty string when there is no input', () => {
    expect(handle({ type: 'driver.field.get' })).toEqual({ value: '' });
  });

  it('ignores unknown messages in a field frame', () => {
    expect(handle({ type: 'driver.unknown' })).toBeUndefined();
  });

  it('ignores checkout messages in a field frame', () => {
    expect(handle({ type: 'driver.ready' })).toBeUndefined();
  });
});

describe('checkout driver.ready', () => {
  beforeEach(() => setLocation('https://www.bigw.com.au/checkout/delivery'));

  it('is not ready on an empty DOM', () => {
    expect(handle({ type: 'driver.ready' })).toEqual({ ready: false, hasThreeFields: false, hasSavedCards: false, continueButton: false });
  });

  it('is ready once the three Gr4vy input iframes exist', () => {
    for (let index = 0; index < 3; index++) {
      const frame = document.createElement('iframe');
      frame.src = `https://secure-fields.wpay2.gr4vy.app/input.html?type=field${index}`;
      document.body.appendChild(frame);
    }
    expect(handle({ type: 'driver.ready' })).toMatchObject({ ready: true, hasThreeFields: true, hasSavedCards: false });
  });

  it('is ready when the saved-cards container is present', () => {
    const saved = document.createElement('div');
    saved.id = 'saved-cards--nextgen';
    document.body.appendChild(saved);
    expect(handle({ type: 'driver.ready' })).toMatchObject({ ready: true, hasThreeFields: false, hasSavedCards: true });
  });

  it('reports the Continue to Payment button without becoming ready', () => {
    const button = document.createElement('button');
    button.textContent = 'Continue to Payment';
    document.body.appendChild(button);
    expect(handle({ type: 'driver.ready' })).toMatchObject({ ready: false, continueButton: true });
  });
});

describe('checkout driver.state', () => {
  it('reports confirmed when the body text says the order is confirmed', () => {
    setLocation('https://www.bigw.com.au/checkout/confirmation');
    Object.defineProperty(document.body, 'innerText', { value: 'Thank you, your order confirmed', configurable: true });
    expect(handle({ type: 'driver.state' })).toEqual({ url: 'https://www.bigw.com.au/checkout/confirmation', challenge: false, confirmed: true });
  });

  it('reports challenge on a 3d-secure path', () => {
    setLocation('https://www.bigw.com.au/checkout/3d-secure');
    Object.defineProperty(document.body, 'innerText', { value: '', configurable: true });
    expect(handle({ type: 'driver.state' })).toMatchObject({ challenge: true, confirmed: false });
  });

  it('reports challenge when a 3DS iframe is mounted', () => {
    setLocation('https://www.bigw.com.au/checkout/delivery');
    Object.defineProperty(document.body, 'innerText', { value: '', configurable: true });
    const frame = document.createElement('iframe');
    frame.src = 'https://challenge.example/3ds';
    document.body.appendChild(frame);
    expect(handle({ type: 'driver.state' })).toMatchObject({ challenge: true });
  });

  it('reports a clean state otherwise', () => {
    setLocation('https://www.bigw.com.au/checkout/delivery');
    Object.defineProperty(document.body, 'innerText', { value: '', configurable: true });
    expect(handle({ type: 'driver.state' })).toEqual({ url: 'https://www.bigw.com.au/checkout/delivery', challenge: false, confirmed: false });
  });
});

describe('checkout clicks', () => {
  beforeEach(() => setLocation('https://www.bigw.com.au/checkout/delivery'));

  it('driver.clickPay clicks the new-card form submit button', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-testid', 'pay-with-new-card');
    const form = document.createElement('form');
    form.addEventListener('submit', event => event.preventDefault());
    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Pay';
    const click = vi.fn();
    button.addEventListener('click', click);
    form.appendChild(button);
    wrapper.appendChild(form);
    document.body.appendChild(wrapper);
    expect(handle({ type: 'driver.clickPay' })).toEqual({ clicked: true });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('driver.clickPay falls back to the credit-card pay button and reports no click when absent', () => {
    expect(handle({ type: 'driver.clickPay' })).toEqual({ clicked: false });
    const button = document.createElement('button');
    button.textContent = 'Pay $22.00 with credit card';
    const click = vi.fn();
    button.addEventListener('click', click);
    document.body.appendChild(button);
    expect(handle({ type: 'driver.clickPay' })).toEqual({ clicked: true });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('driver.newCardView clicks the savedOrNewCards radio', () => {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'savedOrNewCards';
    radio.value = 'false';
    const click = vi.fn();
    radio.addEventListener('click', click);
    document.body.appendChild(radio);
    expect(handle({ type: 'driver.newCardView' })).toEqual({ clicked: true });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('driver.newCardView falls back to a New card button', () => {
    const button = document.createElement('button');
    button.textContent = 'Use a new card';
    const click = vi.fn();
    button.addEventListener('click', click);
    document.body.appendChild(button);
    expect(handle({ type: 'driver.newCardView' })).toEqual({ clicked: true });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('driver.continueToPayment clicks the Continue button', () => {
    const button = document.createElement('button');
    button.textContent = 'Continue to Payment';
    const click = vi.fn();
    button.addEventListener('click', click);
    document.body.appendChild(button);
    expect(handle({ type: 'driver.continueToPayment' })).toEqual({ clicked: true });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('driver.continueToPayment refuses a disabled button', () => {
    const button = document.createElement('button');
    button.textContent = 'Continue to Payment';
    button.disabled = true;
    const click = vi.fn();
    button.addEventListener('click', click);
    document.body.appendChild(button);
    expect(handle({ type: 'driver.continueToPayment' })).toEqual({ clicked: false });
    expect(click).not.toHaveBeenCalled();
  });

  it('driver.clickAfterpay selects Afterpay and re-clicks its pay button on a lazy SDK', async () => {
    vi.useFakeTimers();
    try {
      const label = document.createElement('label');
      label.textContent = 'Afterpay';
      const radio = document.createElement('input');
      radio.type = 'radio';
      label.appendChild(radio);
      document.body.appendChild(label);
      const button = document.createElement('button');
      button.textContent = 'Pay with Afterpay';
      const click = vi.fn();
      button.addEventListener('click', click);
      document.body.appendChild(button);

      const result = handle({ type: 'driver.clickAfterpay' }) as Promise<{ selected: boolean; clicked: boolean }>;
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ selected: true, clicked: true });
      expect(click).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('driver.clickAfterpay reports no button when Afterpay is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const result = handle({ type: 'driver.clickAfterpay' }) as Promise<{ selected: boolean; clicked: boolean }>;
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ selected: false, clicked: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores unknown checkout messages', () => {
    expect(handle({ type: 'driver.unknown' })).toBeUndefined();
  });
});

describe('rebuild awareness', () => {
  it('notifies on iframe changes, throttled to one per 300 ms', async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension', sendMessage } });
    let clock = 0;
    const observer = observeRebuilds(document.body, () => clock);

    document.body.appendChild(document.createElement('iframe'));
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    clock = 100;
    document.body.appendChild(document.createElement('iframe'));
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    clock = 400;
    document.body.appendChild(document.createElement('iframe'));
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    observer?.disconnect();
  });

  it('ignores non-iframe mutations', async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension', sendMessage } });
    const observer = observeRebuilds(document.body, () => 1000);
    document.body.appendChild(document.createElement('span'));
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
    observer?.disconnect();
  });

  it('does not notify when the runtime id is unavailable', async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', { runtime: { id: undefined, sendMessage } });
    notifyFieldsChanged();
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('runtime message responder contract', () => {
  it('replies synchronously and returns false for a sync handler', () => {
    setLocation('https://www.bigw.com.au/checkout/delivery');
    const sendResponse = vi.fn();
    const result = onMessage({ type: 'driver.ready' }, {} as chrome.runtime.MessageSender, sendResponse);
    expect(result).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ready: expect.any(Boolean) }));
  });

  it('replies via sendResponse asynchronously and returns true for an async handler', async () => {
    vi.useFakeTimers();
    try {
      setLocation('https://www.bigw.com.au/checkout/delivery');
      const label = document.createElement('label');
      label.textContent = 'Afterpay';
      const radio = document.createElement('input');
      radio.type = 'radio';
      label.appendChild(radio);
      document.body.appendChild(label);
      const button = document.createElement('button');
      button.textContent = 'Pay with Afterpay';
      document.body.appendChild(button);
      const sendResponse = vi.fn();
      const result = onMessage({ type: 'driver.clickAfterpay' }, {} as chrome.runtime.MessageSender, sendResponse);
      expect(result).toBe(true);
      await vi.runAllTimersAsync();
      expect(sendResponse).toHaveBeenCalledWith({ selected: true, clicked: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw synchronously when an async handler rejects', async () => {
    setLocation('https://www.bigw.com.au/checkout/delivery');
    vi.spyOn(document, 'querySelectorAll').mockImplementation(() => { throw new Error('boom'); });
    const sendResponse = vi.fn();
    expect(() => onMessage({ type: 'driver.clickAfterpay' }, {} as chrome.runtime.MessageSender, sendResponse)).not.toThrow();
    await flush();
    expect(sendResponse).toHaveBeenCalledWith(undefined);
  });
});
