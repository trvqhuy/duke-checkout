import type { CheckoutRun } from '../shared/types.ts';
import { retainRunHistory } from '../shared/history.ts';

const running = (run: CheckoutRun) => ['queued', 'running', 'action_required'].includes(run.status);

export function mergeRuns(current: CheckoutRun[], incoming: CheckoutRun[]): CheckoutRun[] {
  const byId = new Map(current.map(run => [run.id, run]));
  for (const next of incoming) {
    const previous = byId.get(next.id);
    if (!previous || Date.parse(next.updatedAt) > Date.parse(previous.updatedAt)
      || (next.updatedAt === previous.updatedAt && (running(previous) || !running(next)))) byId.set(next.id, next);
  }
  return retainRunHistory([...byId.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)));
}

export function activeRunId(runs: CheckoutRun[], proposed: string | null): string | null {
  return proposed && runs.some(run => run.id === proposed && !run.finishedAt) ? proposed : null;
}
