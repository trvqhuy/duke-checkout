import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type ConnectionTransport, type Page } from 'puppeteer-core';
import WebSocket from 'ws';
import type { ConnectionState } from '../../shared/types.ts';
import { AppError } from '../errors.ts';

interface DiscoveryOptions { endpoint?: string; userDataDir?: string }

// A lightweight BIG W same-origin document used as the origin for API calls
// during preparation. It carries no analytics or payment SDK, so it stays cheap
// and quiet while the cart is prepared in the background.
export const PREP_ORIGIN = 'https://www.bigw.com.au/robots.txt';

function defaultProfiles(): string[] {
  if (platform() === 'darwin') return [join(homedir(), 'Library/Application Support/Google/Chrome'), join(homedir(), 'Library/Application Support/Chromium')];
  if (platform() === 'win32') return [join(process.env.LOCALAPPDATA ?? homedir(), 'Google/Chrome/User Data')];
  return ['google-chrome', 'google-chrome-beta', 'chromium'].map(name => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), name));
}

export async function discoverEndpoint(options: DiscoveryOptions = {}): Promise<string> {
  if (options.endpoint) {
    try { const url = new URL(options.endpoint); if (['ws:', 'wss:'].includes(url.protocol)) return url.href; } catch { /* Report a safe configuration error below. */ }
    throw new AppError('BROWSER_CONFIG', 'BROWSER_WS_ENDPOINT must be a browser WebSocket URL.');
  }
  const profiles = options.userDataDir ? [options.userDataDir] : defaultProfiles();
  for (const profile of profiles) {
    try {
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/).map(part => part.trim());
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(path ?? '')) {
        throw new AppError('BROWSER_CONFIG', 'Chrome published invalid remote debugging connection data. Restart its remote debugging session.');
      }
      return `ws://127.0.0.1:${Number(port)}${path}`;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('BROWSER_CONFIG', 'Chrome remote debugging connection data could not be read.');
    }
  }
  throw new AppError('BROWSER_SETUP', 'Open chrome://inspect/#remote-debugging in your existing Chrome and enable remote debugging. Keep Chrome open, then connect again.');
}

async function openTransport(endpoint: string): Promise<ConnectionTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      handshakeTimeout: 60_000, perMessageDeflate: false, allowSynchronousEvents: false,
      maxPayload: 64 * 1024 * 1024, headers: { 'User-Agent': 'Duke Checkout' },
    });
    const fail = () => reject(new AppError('BROWSER_PERMISSION', 'Chrome did not accept the connection. Allow Duke Checkout in Chrome’s remote debugging prompt, then connect again.', 503));
    socket.once('error', fail);
    socket.once('open', () => {
      socket.removeListener('error', fail);
      const transport: ConnectionTransport = {
        send: message => socket.send(message),
        close: () => socket.close(),
      };
      socket.on('message', data => transport.onmessage?.(data.toString()));
      socket.on('close', () => transport.onclose?.());
      socket.on('error', () => transport.onclose?.());
      resolve(transport);
    });
  });
}

export class BrowserConnection extends EventEmitter {
  state: ConnectionState = { status: 'disconnected', message: 'Connect to the Chrome you already use.' };
  private browser?: Browser;
  private workPage?: Page;
  private connecting?: Promise<ConnectionState>;
  constructor(private readonly options: DiscoveryOptions = {}) { super(); }

  private update(state: ConnectionState): void { this.state = state; this.emit('change', state); }

  connect(): Promise<ConnectionState> {
    if (this.browser?.connected) return Promise.resolve(this.state);
    if (this.connecting) return this.connecting;
    this.update({ status: 'connecting', message: 'Waiting for Chrome. Allow Duke Checkout if Chrome asks.' });
    this.connecting = this.attach().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async attach(): Promise<ConnectionState> {
    let transport: ConnectionTransport | undefined;
    try {
      const endpoint = await discoverEndpoint({ endpoint: this.options.endpoint ?? process.env.BROWSER_WS_ENDPOINT, userDataDir: this.options.userDataDir ?? process.env.CHROME_USER_DATA_DIR });
      transport = await openTransport(endpoint);
      this.browser = await puppeteer.connect({ transport, defaultViewport: null, protocolTimeout: 30_000 });
      this.browser.once('disconnected', () => { this.browser = undefined; this.workPage = undefined; this.update({ status: 'disconnected', message: 'Chrome disconnected. Reconnect to continue.' }); });
      const browser = await this.browser.version();
      this.update({ status: 'connected', message: 'Your existing Chrome session is connected.', browser });
      return this.state;
    } catch (error) {
      transport?.close();
      const failure = error instanceof AppError ? error : new AppError('BROWSER_CONNECT', 'Chrome could not be attached. Check its remote debugging permission and reconnect.', 503);
      this.update({ status: 'error', message: failure.message });
      throw failure;
    }
  }

  async page(): Promise<Page> {
    await this.connect();
    // Reuse our dedicated working tab only. Do not repurpose one of the user's
    // own tabs, which would navigate them away from what they were doing.
    if (this.workPage && !this.workPage.isClosed()) return this.workPage;
    // Adopt our own working tab left over from a previous app session (it carries
    // a per-tab marker), so restarts reuse one tab instead of accumulating tabs.
    const existing = await this.findWorkingTab();
    if (existing) { this.workPage = existing; return existing; }
    const page = await this.openBackground(PREP_ORIGIN);
    await this.mark(page);
    this.workPage = page;
    return page;
  }

  private async findWorkingTab(): Promise<Page | undefined> {
    for (const page of await this.browser!.pages()) {
      if (page.isClosed() || !page.url().startsWith('https://www.bigw.com.au/')) continue;
      try { if (await page.evaluate('sessionStorage.getItem("duke-work") === "1"')) return page; } catch { /* tab not ready */ }
    }
    return undefined;
  }

  private async mark(page: Page): Promise<void> {
    await page.evaluate('sessionStorage.setItem("duke-work", "1")').catch(() => undefined);
  }

  // A dedicated tab on a lightweight same-origin document. It stays in the
  // background during API preparation and is only revealed for the final step.
  private async openBackground(url: string): Promise<Page> {
    const client = await this.browser!.target().createCDPSession();
    try {
      const { targetId } = await client.send('Target.createTarget', { url, background: true }) as { targetId: string };
      const target = await this.browser!.waitForTarget(existing => (existing as unknown as { _targetId: string })._targetId === targetId, { timeout: 15_000 });
      const page = await target.page();
      if (!page) throw new AppError('BROWSER_TAB', 'A background working tab could not be created.');
      await page.waitForFunction('document.readyState !== "loading"', { timeout: 15_000 }).catch(() => undefined);
      return page;
    } finally {
      await client.detach().catch(() => undefined);
    }
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.workPage = undefined;
    await browser?.disconnect();
  }
}
