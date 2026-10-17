// Toolbar badge — a glanceable state indicator for the extension action.
// Pure mapping (state -> text/colour) plus a thin chrome.action writer. The
// service worker drives the state: arm -> armed, clear -> idle, and each
// run.update -> running while in flight and a terminal glyph afterwards.
import type { CheckoutRun } from '../../shared/types.ts';

export type BadgeState = 'idle' | 'armed' | 'running' | 'succeeded' | 'failed' | 'attention';

const BADGES: Record<BadgeState, { text: string; color: string }> = {
  idle: { text: '', color: '#5f6368' },
  armed: { text: 'a', color: '#188038' },
  running: { text: '…', color: '#5f6368' },
  succeeded: { text: '✓', color: '#188038' },
  failed: { text: '✗', color: '#d93025' },
  attention: { text: '!', color: '#e37400' },
};

export function setBadge(state: BadgeState): void {
  const badge = BADGES[state] ?? BADGES.idle;
  try {
    void chrome.action.setBadgeText({ text: badge.text });
    void chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch { /* action API unavailable (tests, non-extension host) */ }
}

// Maps a run's lifecycle status onto the badge vocabulary. 'ready' is a
// completed preparation (prepare/assist) and reads as success; an unknown
// payment outcome needs the user, so it maps to attention rather than failure.
export function badgeStateForRun(run: Pick<CheckoutRun, 'status'>): BadgeState {
  switch (run.status) {
    case 'queued':
    case 'running': return 'running';
    case 'action_required':
    case 'payment_unknown': return 'attention';
    case 'succeeded':
    case 'ready': return 'succeeded';
    case 'failed':
    case 'cancelled': return 'failed';
    default: return 'idle';
  }
}
