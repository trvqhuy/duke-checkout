const REFRESH_THRESHOLD_SECONDS = 240;

export function shouldRefresh(state: { armed: boolean; authenticated: boolean; tokenSecondsRemaining: number }): boolean {
  return state.armed && state.authenticated && state.tokenSecondsRemaining < REFRESH_THRESHOLD_SECONDS;
}

// Alarm callback: reload the work tab so the BIG W page's own SDK renews the
// token (same recovery as the server's keepSessionFresh). Reloading whichever
// real BIG W page is open keeps an armed checkout page warm after its reload.
export async function refreshSession(getBridge: () => Promise<{ tabId: number }>): Promise<void> {
  const { tabId } = await getBridge();
  await chrome.tabs.reload(tabId).catch(() => undefined);
}

export function registerKeeper(
  getBridge: () => Promise<{ tabId: number }>,
  readState: () => Promise<{ armed: boolean; authenticated: boolean; tokenSecondsRemaining: number }>,
): void {
  chrome.alarms.create('duke-keeper', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== 'duke-keeper') return;
    void readState()
      .then(state => (shouldRefresh(state) ? refreshSession(getBridge) : undefined))
      .catch(() => undefined);
  });
}
