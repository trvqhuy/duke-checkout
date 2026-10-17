// app-page routes the service worker to the extension's app.html tab. The
// active-run guard is the interesting bit: an open app tab hosts the `duke-run`
// port that keeps the worker alive, so it must not be reloaded mid-run.
import { beforeEach, describe, expect, it } from 'vitest';
import { appUrlFor, configureAppPage, ensureAppPage, openAppPage } from '../../src/extension/background/app-page.ts';

const updated: Array<{ tabId: number; props: Record<string, unknown> }> = [];
const createdTabs: Array<Record<string, unknown>> = [];
let contexts: Array<{ documentUrl?: string; tabId?: number }> = [];

(globalThis as Record<string, unknown>).chrome = {
  runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, getContexts: async () => contexts },
  tabs: {
    TAB_ID_NONE: -1,
    query: async () => [],
    create: async (options: Record<string, unknown>) => { createdTabs.push(options); return { id: 1 }; },
    update: async (tabId: number, props: Record<string, unknown>) => { updated.push({ tabId, props }); return { id: tabId }; },
  },
};

beforeEach(() => {
  updated.length = 0;
  createdTabs.length = 0;
  contexts = [];
  configureAppPage({});
});

describe('appUrlFor', () => {
  it('appends the query string, or returns the bare URL when empty', () => {
    expect(appUrlFor()).toBe('chrome-extension://test/app.html');
    expect(appUrlFor({ product: 'x' })).toBe('chrome-extension://test/app.html?product=x');
  });
});

describe('openAppPage', () => {
  it('re-points an existing app tab when no run is active', async () => {
    contexts = [{ documentUrl: 'chrome-extension://test/app.html', tabId: 7 }];
    configureAppPage({ activeRunId: () => null });
    await openAppPage({ product: 'x' });
    expect(updated).toEqual([{ tabId: 7, props: { url: 'chrome-extension://test/app.html?product=x', active: true } }]);
    expect(createdTabs).toEqual([]);
  });

  it('focuses an existing app tab without reloading it while a run is active', async () => {
    contexts = [{ documentUrl: 'chrome-extension://test/app.html', tabId: 7 }];
    configureAppPage({ activeRunId: () => 'run-1' });
    await openAppPage({ product: 'x' });
    expect(updated).toEqual([{ tabId: 7, props: { active: true } }]);
    expect(createdTabs).toEqual([]);
  });

  it('opens a new foreground app tab when none exists', async () => {
    await openAppPage({ onboarding: '1' });
    expect(createdTabs).toEqual([{ url: 'chrome-extension://test/app.html?onboarding=1', active: true }]);
  });
});

describe('ensureAppPage', () => {
  it('creates a background app tab only when none exists', async () => {
    await ensureAppPage();
    expect(createdTabs).toEqual([{ url: 'chrome-extension://test/app.html', active: false }]);
    createdTabs.length = 0;
    contexts = [{ documentUrl: 'chrome-extension://test/app.html', tabId: 7 }];
    await ensureAppPage();
    expect(createdTabs).toEqual([]);
  });
});
