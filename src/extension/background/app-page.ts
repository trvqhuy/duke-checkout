// ---------------------------------------------------------------------------
// app-page — routing to the extension's app.html tab (Stage 3)
// ---------------------------------------------------------------------------
// The service worker opens app.html to collect a profile, a card, or a
// confirmation before a run, and to host the `duke-run` port that keeps the
// worker alive during a run. This module owns finding, focusing, and opening
// that tab. It imports nothing from triggers.ts or notify.ts, so both can use
// it without a module cycle (previously notify -> triggers -> notify).
//
// A run holds the app page's `duke-run` port open; navigating an existing app
// tab would reload it and tear the port down mid-run. When a run is active,
// openAppPage therefore only focuses the existing tab. The active-run getter is
// injected by the service worker via configureAppPage (wired from the same
// configureTriggers call that owns the manager).
// ---------------------------------------------------------------------------

export function appUrlFor(query: Record<string, string> = {}): string {
  const base = chrome.runtime.getURL('app.html');
  const search = new URLSearchParams(query).toString();
  return search ? `${base}?${search}` : base;
}

export async function appPageIsOpen(): Promise<boolean> { return (await findAppTabId()) !== null; }

async function findAppTabId(): Promise<number | null> {
  const base = chrome.runtime.getURL('app.html');
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const match = contexts.find(context => (context.documentUrl ?? '').startsWith(base));
    if (match && typeof match.tabId === 'number' && match.tabId !== chrome.tabs.TAB_ID_NONE) return match.tabId;
  } catch { /* getContexts is Chrome 116+; fall through to the tab query */ }
  try {
    const tabs = await chrome.tabs.query({ url: `${base}*` });
    return tabs[0]?.id ?? null;
  } catch { return null; }
}

interface AppPageDeps { activeRunId?(): string | null }
let deps: AppPageDeps = {};
export function configureAppPage(next: AppPageDeps): void { deps = next; }

// Focus an existing app page (idempotently re-pointing it at the requested
// query) or open a new one. Query params carry product/onboarding intent.
export async function openAppPage(query: Record<string, string> = {}): Promise<void> {
  const url = appUrlFor(query);
  const tabId = await findAppTabId();
  if (tabId !== null) {
    // Never reload an existing app tab while a run is in flight: the reload
    // would drop the `duke-run` port that keeps the service worker alive. Just
    // bring the tab forward so the user can watch the run.
    if (deps.activeRunId?.()) { await chrome.tabs.update(tabId, { active: true }).catch(() => undefined); return; }
    await chrome.tabs.update(tabId, { url, active: true }).catch(() => undefined);
    return;
  }
  await chrome.tabs.create({ url, active: true }).catch(() => undefined);
}

// A run needs an app page open so its `duke-run` port keeps the worker alive.
export async function ensureAppPage(): Promise<void> {
  if (await findAppTabId() !== null) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL('app.html'), active: false }).catch(() => undefined);
}
