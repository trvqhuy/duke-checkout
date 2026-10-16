import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { STAGES, type CheckoutRun, type Profile } from '../shared/types.ts';
import { validateProfile } from '../shared/validation.ts';
import { retainRunHistory } from '../shared/history.ts';
import { AppError } from './errors.ts';

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

export class LocalStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(public readonly directory: string) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async read(name: string): Promise<unknown[]> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (!Array.isArray(value)) throw new Error('Invalid array');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new AppError('STORAGE', `The local ${name} file could not be read. Preserve it and check its JSON before continuing.`, 500);
    }
  }

  private async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.directory, name));
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  async profiles(): Promise<Profile[]> {
    return (await this.read('profiles.json')).map(validateProfile);
  }

  async saveProfile(input: unknown): Promise<Profile> {
    const profile = validateProfile(input);
    return this.serial(async () => {
      const profiles = await this.profiles();
      const saved = { ...profile, id: profile.id ?? randomUUID() };
      const index = profiles.findIndex(item => item.id === saved.id);
      if (index < 0) profiles.push(saved); else profiles[index] = saved;
      await this.write('profiles.json', profiles);
      return saved;
    });
  }

  async deleteProfile(id: string): Promise<void> {
    await this.serial(async () => { await this.write('profiles.json', (await this.profiles()).filter(profile => profile.id !== id)); });
  }

  async runs(): Promise<CheckoutRun[]> {
    return (await this.read('runs.json')).map(sanitizeRun);
  }

  // A stable per-install random value used as the local request token. Persisting
  // it means a server restart does not invalidate an already-open browser tab.
  async localToken(): Promise<string> {
    const file = join(this.directory, 'local-token');
    try {
      const existing = (await readFile(file, 'utf8')).trim();
      if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(file, token, { mode: 0o600 });
    return token;
  }

  async saveRuns(runs: CheckoutRun[]): Promise<void> {
    const snapshot = retainRunHistory(runs).map(sanitizeRun);
    await this.serial(() => this.write('runs.json', snapshot));
  }
}
