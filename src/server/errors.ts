import { z } from 'zod';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, options?: ErrorOptions) { super(message, options); this.name = 'AppError'; }
}

export function publicError(error: unknown): { code: string; message: string; fields?: Record<string, string> } {
  if (error instanceof z.ZodError) {
    return { code: 'VALIDATION', message: 'Please check the highlighted fields.', fields: Object.fromEntries(error.issues.map(issue => [issue.path.join('.'), issue.message])) };
  }
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === 'AbortError') return { code: 'CANCELLED', message: 'The run was cancelled before payment.' };
  return { code: 'UNEXPECTED', message: 'This step could not finish. Check the BIG W tab and try a new preparation run.' };
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}
