import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Bootstrap, CheckoutRun, Profile } from '../src/shared/types.ts';
import { parseProductLink } from '../src/shared/validation.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const values = new Map<string, string>();
const allowed = new Set(['--url', '--max-total', '--quantity', '--server']);
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Prepare-only integration check:\n  npm run smoke -- --url "BIG_W_PRODUCT_URL" --max-total 25.00 [--quantity 1] [--server http://127.0.0.1:4317]\nThis command has no purchase mode and accepts no card data.');
  process.exit(0);
}
for (let index = 0; index < args.length; index += 2) {
  if (!allowed.has(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Use --help for the supported prepare-only options.');
  values.set(args[index], args[index + 1]);
}
const product = parseProductLink(values.get('--url') ?? '');
const server = new URL(values.get('--server') ?? `http://127.0.0.1:${process.env.PORT ?? 4317}`);
if (server.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname) || server.username || server.password || server.pathname !== '/') throw new Error('The smoke check only connects to a local Duke server.');
const origin = server.origin;
let token = '', cookie = '';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-local-token': token }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'The local API rejected this preparation check.');
  return result as T;
}

try {
  token = (await request<Bootstrap>('/bootstrap')).csrfToken;
  const { profile } = await request<{ profile: Profile }>('/browser/import-profile', {});
  const { run } = await request<{ run: CheckoutRun }>('/runs', {
    requestId: randomUUID(), productUrl: product.url, quantity: Number(values.get('--quantity') ?? 1),
    maxTotal: values.get('--max-total') ?? '25.00', profile, mode: 'prepare',
  });
  let count = 0;
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const current = (await request<{ run: CheckoutRun }>(`/runs/${run.id}`)).run;
    if (current.mode !== 'prepare' || current.paymentSubmittedAt) throw new Error('Unexpected run mode; the smoke command only supports preparation.');
    for (const event of current.events.slice(count)) console.log(`[${(event.elapsedMs / 1000).toFixed(1)}s] ${event.message}`);
    count = current.events.length;
    if (current.finishedAt) {
      if (current.status !== 'ready') throw new Error(current.error?.message ?? `Preparation ended with status ${current.status}.`);
      console.log(`Ready: A$${((current.totalCents ?? 0) / 100).toFixed(2)} in ${(current.elapsedMs / 1000).toFixed(1)}s. No payment was submitted.`);
      process.exit(0);
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  await request(`/runs/${run.id}/cancel`, {});
  throw new Error('Preparation exceeded two minutes and was cancelled. Check the Chrome tab.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Preparation could not finish.');
  process.exitCode = 1;
}
