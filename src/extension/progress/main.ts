// ---------------------------------------------------------------------------
// progress — the tab a chip opens before a checkout run
// ---------------------------------------------------------------------------
// It exists so a one-click checkout has an immediate, honest surface: the run's
// live stage, quantity, product, total, and any failure with the exact remedy.
// When preparation reaches the checkout, the adapter navigates THIS tab to BIG W
// (see revealPrepared / presentationTabId), so the progress page is replaced by
// the real checkout instead of a second tab appearing out of nowhere.
//
// Deliberately dependency-free: no React, no shared runtime chunks, inline CSS.
// The page is on screen within milliseconds and holds the `duke-run` port that
// keeps the MV3 worker alive while it waits on the retailer.
// ---------------------------------------------------------------------------
import type { CheckoutRun, Stage } from '../../shared/types.ts';
import type { DukeResponse } from '../lib/protocol.ts';

const STAGES: Stage[] = ['connect', 'inspect', 'cart', 'contact', 'payment', 'complete'];
const STAGE_LABELS: Record<Stage, string> = {
  connect: 'Browser & session', inspect: 'Product & availability', cart: 'Cart & delivery',
  contact: 'Contact & billing', payment: 'Secure payment', complete: 'Complete',
};
const TERMINAL = new Set(['ready', 'succeeded', 'failed', 'cancelled', 'payment_unknown']);

const params = new URLSearchParams(location.search);
const requestId = params.get('request') ?? '';

const titleEl = byId('title');
const subEl = byId('sub');
const summaryEl = byId('summary');
const stagesEl = byId('stages');
const messageEl = byId('message');
const actionsEl = byId('actions');

let runId: string | null = null;
let port: chrome.runtime.Port | null = null;
let connected = false;
let lastStatus = '';

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`progress page is missing #${id}`);
  return element;
}

async function request<T>(type: string, payload: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage({ id: crypto.randomUUID(), type, payload }) as DukeResponse | undefined;
  if (!response?.ok) throw new Error(response?.error?.message ?? 'The extension background did not answer.');
  return response.result as T;
}

function holdWorker(): void {
  if (connected) return;
  connected = true;
  try { port = chrome.runtime.connect({ name: 'duke-run' }); } catch { /* worker may be starting */ }
}

function releaseWorker(): void {
  if (!connected) return;
  connected = false;
  try { port?.disconnect(); } catch { /* already closed */ }
  port = null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function action(label: string, style: 'primary' | 'secondary' | 'ghost', onClick: () => void): HTMLButtonElement {
  const button = el('button', style, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    return `${parsed.hostname}${path.length > 48 ? `${path.slice(0, 47)}…` : path}`;
  } catch { return url; }
}

function render(run: CheckoutRun): void {
  runId = run.id;
  lastStatus = run.status;
  const terminal = TERMINAL.has(run.status);
  const successful = run.status === 'succeeded' || run.status === 'ready';
  const failed = run.status === 'failed' || run.status === 'cancelled' || run.status === 'payment_unknown';

  titleEl.textContent = run.status === 'succeeded' ? 'Order placed'
    : run.status === 'ready' ? 'Checkout is ready'
    : run.status === 'payment_unknown' ? 'Check the order outcome'
    : failed ? 'Checkout stopped'
    : run.status === 'action_required' ? 'Your bank needs you'
    : 'Preparing your order';
  document.title = `Duke · ${titleEl.textContent}`;

  subEl.textContent = successful ? 'The BIG W tab is ready for you.'
    : failed ? 'Nothing was paid unless the message below says otherwise.'
    : run.status === 'action_required' ? 'Complete authentication in the BIG W tab; Duke is still watching.'
    : 'A new tab will become the BIG W checkout as soon as it is ready.';

  summaryEl.replaceChildren();
  const product = run.product?.title ?? `Article ${run.productCode}`;
  summaryEl.append(
    el('span', 'pill', product),
    el('span', 'pill', `Quantity ${run.quantity}`),
    el('span', 'pill', run.mode === 'purchase' ? 'Purchase automatically' : run.mode === 'assist' ? 'Fill card only' : run.mode === 'afterpay' ? 'Afterpay' : 'Prepare only'),
  );
  if (run.totalCents !== undefined) summaryEl.append(el('span', 'pill', `Delivered total $${(run.totalCents / 100).toFixed(2)}`));
  else summaryEl.append(el('span', 'pill', shortUrl(run.productUrl)));

  const index = STAGES.indexOf(run.stage);
  stagesEl.replaceChildren();
  for (const [stageIndex, stage] of STAGES.entries()) {
    const item = el('li');
    if (successful || stageIndex < index) item.classList.add('done');
    if (run.stage === stage && !successful) item.classList.add('current');
    if (run.stage === stage && failed) item.classList.add('stopped');
    item.append(el('span', 'dot', successful || stageIndex < index ? '✓' : String(stageIndex + 1)), el('span', '', STAGE_LABELS[stage]));
    if (run.stage === stage && !terminal) item.append(el('span', 'pulse'));
    stagesEl.append(item);
  }

  const event = run.events.at(-1);
  messageEl.className = `message${failed ? ' error' : successful ? ' success' : ''}`;
  messageEl.textContent = run.error?.message ?? event?.message ?? 'Starting…';

  actionsEl.replaceChildren();
  if (run.status === 'payment_unknown') {
    const link = el('a', 'button secondary', 'Check BIG W order history');
    link.href = 'https://www.bigw.com.au/my-account/orders';
    link.target = '_blank';
    link.rel = 'noreferrer';
    actionsEl.append(link, action('Open Duke', 'primary', () => { void request('ui.open', null).catch(() => undefined); }));
  } else if (failed) {
    // Setup errors are fixable in Duke; a retailer error just needs a retry.
    const setup = ['PROFILE_REQUIRED', 'CARD_REQUIRED', 'VALIDATION', 'LOGIN_REQUIRED', 'SESSION_EXPIRED', 'BRIDGE_UNREADY'].includes(run.error?.code ?? '');
    if (setup) actionsEl.append(action('Open Duke setup', 'primary', () => { void request('ui.open', null).catch(() => undefined); }));
    actionsEl.append(action('Close this tab', 'secondary', () => {
      void chrome.tabs.getCurrent().then(tab => { if (tab?.id !== undefined) void chrome.tabs.remove(tab.id); });
    }));
  } else if (!terminal && !run.paymentSubmittedAt) {
    actionsEl.append(action('Cancel', 'secondary', () => { cancel(run.id); }));
  }

  if (terminal) releaseWorker();
  else holdWorker();
}

async function cancel(id: string): Promise<void> {
  try {
    const run = await request<CheckoutRun>('run.cancel', { id });
    render(run);
  } catch (error) {
    messageEl.className = 'message error';
    messageEl.textContent = error instanceof Error ? error.message : 'Could not cancel this run.';
  }
}

// The run is created a moment after this tab opens (the trigger creates the tab
// first so the user sees it instantly), so retry until it exists.
async function findRun(): Promise<void> {
  if (!requestId) return;
  try {
    const run = await request<CheckoutRun | null>('run.byRequest', { requestId });
    if (run) { render(run); return; }
  } catch { /* worker starting */ }
  if (lastStatus && TERMINAL.has(lastStatus)) return;
  setTimeout(() => { void findRun(); }, 350);
}

chrome.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as { type?: string; payload?: CheckoutRun };
  if (message?.type !== 'run.update' || !message.payload) return;
  const run = message.payload;
  if (run.id === runId || run.requestId === requestId) render(run);
});

window.addEventListener('pagehide', releaseWorker);
holdWorker();
void findRun();
