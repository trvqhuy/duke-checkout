// ---------------------------------------------------------------------------
// notify — user-facing outcome notifications for checkout runs (Stage 3, Task 4)
// ---------------------------------------------------------------------------
// Notification policy is a pure function (notificationFor) so the copy that
// reaches the user and the statuses that stay silent are decided in one place
// and can be unit-tested without a chrome runtime. Only the thin dispatch
// (notifyOutcome) and the event registration (registerNotifications) touch
// chrome.*, and both are guarded so importing this module stays side-effect
// free.
//
// The icon is a 128x128 PNG inlined as a data URL: no icon asset has to ship
// with the extension. It is defined once here and re-exported so the trigger
// hints use the same mark.
// ---------------------------------------------------------------------------
import { openAppPage } from './triggers.ts';
import type { CheckoutRun } from '../../shared/types.ts';

// Export shape of every notification body.
export interface OutcomeNotification { title: string; message: string }

// The subset of a run the copy depends on.
type NotificationRun = Pick<CheckoutRun, 'status' | 'mode' | 'orderNumber' | 'error'>;
// The copy plus the identity needed to create and dedupe a notification.
type NotifiableRun = NotificationRun & Pick<CheckoutRun, 'id'>;

const TITLE = 'Duke Checkout';

// 128x128 PNG (green disc with a white "D"), inlined. Generated once and kept
// as a constant so the trigger hint and the outcome notifications agree.
export const NOTIFICATION_ICON = 'data:image/png;base64,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';

// The single source of truth for what (if anything) a run's status notifies.
// 'ready' is a completed preparation (prepare/assist) or an opened Afterpay
// hand-off, and the copy depends on the mode that produced it. queued/running
// are in flight; cancelled is user intent — all silent.
export function notificationFor(run: NotificationRun): OutcomeNotification | null {
  switch (run.status) {
    case 'succeeded':
      return { title: TITLE, message: `Order placed. Reference ${run.orderNumber}.` };
    case 'failed':
      return { title: TITLE, message: run.error?.message ?? 'The order was not placed.' };
    case 'payment_unknown':
      return { title: TITLE, message: 'Check BIG W orders — the payment outcome is not confirmed.' };
    case 'action_required':
      return { title: TITLE, message: 'Your bank needs authentication — complete it in the BIG W tab.' };
    case 'ready':
      if (run.mode === 'assist') return { title: TITLE, message: 'Card filled — press Pay in the BIG W tab.' };
      if (run.mode === 'prepare') return { title: TITLE, message: 'Checkout is ready in the BIG W tab.' };
      if (run.mode === 'afterpay') return { title: TITLE, message: 'Afterpay is open in the BIG W tab.' };
      return null;
    case 'cancelled':
    case 'queued':
    case 'running':
    default:
      return null;
  }
}

// Create the basic notification for a run. A stable id (`duke-<run.id>`) means
// a later update with the same id replaces the earlier one rather than stacking.
export function notifyOutcome(run: NotifiableRun): void {
  const content = notificationFor(run);
  if (!content) return;
  try {
    void chrome.notifications.create(`duke-${run.id}`, {
      type: 'basic', iconUrl: NOTIFICATION_ICON, title: content.title, message: content.message, requireInteraction: false,
    }).catch(() => undefined);
  } catch { /* notifications API unavailable (tests, non-extension host) */ }
}

// Dedupe wrapper. A run notifies at most once per status, so the manager's
// many run.update publishes for one run produce a single notification for
// action_required and a single one for the terminal outcome that follows it.
export function createNotifier(send: (run: NotifiableRun) => void = notifyOutcome): (run: NotifiableRun) => void {
  const notified = new Set<string>();
  return run => {
    if (!notificationFor(run)) return;
    const key = `${run.id}:${run.status}`;
    if (notified.has(key)) return;
    notified.add(key);
    send(run);
  };
}

// Install the click handler (focus the app page) and return the run-update hook
// the service worker hands to the RunManager. The provided onUpdate (the badge
// mapping) runs first, so a throwing observer cannot suppress the notification.
export function registerNotifications(onUpdate: (run: CheckoutRun) => void): (run: CheckoutRun) => void {
  try {
    chrome.notifications.onClicked.addListener(() => { void openAppPage().catch(() => undefined); });
  } catch { /* notifications API unavailable (tests, non-extension host) */ }
  const notify = createNotifier();
  return run => {
    try { onUpdate(run); } catch { /* observer must not break a run */ }
    notify(run);
  };
}
