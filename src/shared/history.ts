import type { CheckoutRun } from './types.ts';

export function retainRunHistory(runs: CheckoutRun[], preparationLimit = 100): CheckoutRun[] {
  let preparations = 0;
  return runs.filter(run => {
    // Purchase records also provide durable request-id and unknown-outcome
    // protection. Only harmless preparation history is eligible for trimming.
    if (run.mode === 'purchase' || run.status === 'payment_unknown' || (run.paymentSubmittedAt && !run.finishedAt)) return true;
    return preparations++ < preparationLimit;
  });
}
