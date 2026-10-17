import { z } from 'zod';
import { STAGES, type CheckoutRun } from './types.ts';

const safeText = z.string().transform(value => value.replace(/\b(?:\d[ -]?){13,19}\b/g, '[redacted]').replace(/\b(authorization|token|cvv|cvc|card number)\s*[:=]\s*\S+/gi, '$1=[redacted]'));
const productSchema = z.object({
  code: z.string(), url: z.string(), title: safeText, imageUrl: z.string().optional(),
  priceCents: z.number(), deliveryCents: z.number(), available: z.boolean(), stockLabel: safeText,
  releaseLabel: safeText.optional(), deliveryEstimate: safeText.optional(), seller: safeText.optional(), requiresVariant: z.boolean().optional(),
});
const runSchema = z.object({
  id: z.string(), requestId: z.string(), mode: z.enum(['prepare', 'assist', 'purchase', 'afterpay']),
  status: z.enum(['queued', 'running', 'action_required', 'ready', 'succeeded', 'failed', 'cancelled', 'payment_unknown']),
  stage: z.enum(STAGES), productCode: z.string(), productUrl: z.string(), quantity: z.number(), maxTotalCents: z.number(),
  profileName: safeText, startedAt: z.string(), updatedAt: z.string(), finishedAt: z.string().optional(),
  paymentSubmittedAt: z.string().optional(), elapsedMs: z.number(), product: productSchema.optional(),
  totalCents: z.number().optional(), deliveryCents: z.number().optional(), orderNumber: safeText.optional(),
  error: z.object({ code: z.string(), message: safeText }).optional(),
  events: z.array(z.object({ stage: z.enum(STAGES), message: safeText, at: z.string(), elapsedMs: z.number() })),
});

export function sanitizeRun(value: unknown): CheckoutRun {
  return runSchema.parse(value);
}
