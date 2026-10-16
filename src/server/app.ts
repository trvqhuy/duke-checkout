import { timingSafeEqual } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import type { ArmedCheckout, ConnectionState, ProductInfo, Profile, RunRequest, SavedCard, StageReporter } from '../shared/types.ts';
import { parseProductLink, validateProfile } from '../shared/validation.ts';
import { RunManager } from './checkout.ts';
import { AppError, publicError } from './errors.ts';
import { LocalStore } from './storage.ts';

interface Runtime {
  store: LocalStore;
  manager: RunManager;
  token: string;
  browser: Pick<EventEmitter, 'on' | 'off'> & { state: ConnectionState; connect(): Promise<ConnectionState> };
  adapter: {
    inspect(url: string, profile: Profile): Promise<ProductInfo>;
    importProfile(): Promise<{ profile: Profile; savedCards: SavedCard[] }>;
    listCards?(): Promise<SavedCard[]>;
    focus?(): Promise<void>;
    arm?(input: RunRequest, report: StageReporter, signal: AbortSignal): Promise<ArmedCheckout>;
    armedState?(): ArmedCheckout | null;
    disarm?(): void;
  };
}

export function createApp(runtime: Runtime): express.Express {
  const app = express();
  const token = runtime.token;
  let browsing = false;
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const host = request.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) {
      response.status(403).json({ error: { code: 'LOCAL_ONLY', message: 'This workspace is only available on its local address.' } }); return;
    }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) { response.status(403).json({ error: { code: 'ORIGIN', message: 'Use this workspace from its own local browser tab.' } }); return; }
    if (request.headers['sec-fetch-site'] === 'cross-site') { response.status(403).json({ error: { code: 'ORIGIN', message: 'Cross-site requests are not accepted.' } }); return; }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://www.bigw.com.au https://*.scene7.com data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.path.toLowerCase().startsWith('/api/')) {
      response.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const supplied = request.headers['x-local-token'];
        if (typeof supplied !== 'string' || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
          response.status(403).json({ error: { code: 'LOCAL_TOKEN', message: 'Reload this local workspace before continuing.' } }); return;
        }
      }
    }
    next();
  });
  app.use(express.json({ limit: '24kb' }));

  const snapshot = async () => ({ csrfToken: token, profiles: await runtime.store.profiles(), runs: runtime.manager.history(), connection: runtime.browser.state, activeRunId: runtime.manager.activeRunId, armed: runtime.adapter.armedState?.() ?? null });
  const idle = () => {
    if (runtime.manager.activeRunId || browsing) throw new AppError('RUN_ACTIVE', 'A browser operation is already running. Let it finish first.', 409);
  };
  const browse = async <T,>(operation: () => Promise<T>): Promise<T> => {
    idle(); browsing = true;
    try { return await operation(); } finally { browsing = false; }
  };

  app.get('/api/health', (_request, response) => { response.json({ ok: true }); });
  app.get('/api/bootstrap', async (_request, response) => {
    response.setHeader('Set-Cookie', `duke_local=${token}; HttpOnly; SameSite=Strict; Path=/`);
    response.json(await snapshot());
  });
  app.post('/api/browser/connect', (_request, response) => {
    void runtime.browser.connect().catch(() => undefined);
    response.status(202).json({ connection: runtime.browser.state });
  });
  app.post('/api/browser/import-profile', async (_request, response) => { response.json(await browse(() => runtime.adapter.importProfile())); });
  app.post('/api/browser/cards', async (_request, response) => { response.json({ cards: await browse(() => runtime.adapter.listCards?.() ?? Promise.resolve([])) }); });
  app.post('/api/browser/focus', async (_request, response) => { await runtime.adapter.focus?.(); response.json({ ok: true }); });
  // Arm ahead of time: prepare the product, cart, contact, and page so a later
  // matching run only re-checks the cart before payment.
  app.post('/api/arm', async (request, response) => {
    if (!runtime.adapter.arm) throw new AppError('UNSUPPORTED', 'This adapter does not support armed preparation.');
    const data = z.object({ productUrl: z.string(), quantity: z.number().int().min(1).max(20), maxTotal: z.union([z.string(), z.number()]), profile: z.unknown() }).strict().parse(request.body);
    let link: { url: string };
    try { link = parseProductLink(data.productUrl); } catch { throw new AppError('PRODUCT_LINK', 'Use a secure BIG W product link ending in /p/article-number.'); }
    const profile = validateProfile(data.profile);
    const maxTotalCents = Math.round(Number(data.maxTotal) * 100);
    if (!Number.isSafeInteger(maxTotalCents) || maxTotalCents <= 0) throw new AppError('BUDGET', 'Enter a delivered budget above zero.');
    const input: RunRequest = { productUrl: link.url, quantity: data.quantity, maxTotalCents, mode: 'purchase', profile };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      response.json({ armed: await browse(() => runtime.adapter.arm!(input, () => undefined, controller.signal)) });
    } finally {
      clearTimeout(timer);
    }
  });
  app.delete('/api/arm', async (_request, response) => { runtime.adapter.disarm?.(); response.json({ ok: true }); });
  app.post('/api/inspect', async (request, response) => {
    const data = z.object({ productUrl: z.string(), profile: z.unknown() }).strict().parse(request.body);
    let link: { url: string };
    try { link = parseProductLink(data.productUrl); } catch { throw new AppError('PRODUCT_LINK', 'Use a secure BIG W product link ending in /p/article-number.'); }
    const profile = validateProfile(data.profile);
    response.json({ product: await browse(() => runtime.adapter.inspect(link.url, profile)) });
  });
  app.post('/api/profiles', async (request, response) => { response.status(201).json({ profile: await runtime.store.saveProfile(request.body) }); });
  app.delete('/api/profiles/:id', async (request, response) => {
    await runtime.store.deleteProfile(String(request.params.id)); response.json({ ok: true });
  });
  app.get('/api/runs/:id', (request, response) => { response.json({ run: runtime.manager.get(String(request.params.id)) }); });
  app.post('/api/runs', async (request, response) => {
    if (browsing) throw new AppError('BROWSER_BUSY', 'Product inspection or profile import is still running. Wait for it to finish.', 409);
    response.status(202).json({ run: await runtime.manager.start(request.body) });
  });
  app.post('/api/runs/:id/cancel', (request, response) => { response.json({ run: runtime.manager.cancel(String(request.params.id)) }); });
  app.post('/api/runs/:id/resolve', async (request, response) => {
    const data = z.object({ resolution: z.enum(['confirmed', 'not_purchased']), orderNumber: z.string().optional() }).strict().parse(request.body);
    response.json({ run: await runtime.manager.resolve(String(request.params.id), data.resolution, data.orderNumber) });
  });
  app.get('/api/events', (request, response) => {
    const cookie = request.headers.cookie?.split('; ').find(value => value.startsWith('duke_local='))?.slice('duke_local='.length);
    if (cookie !== token) { response.status(403).json({ error: { code: 'LOCAL_SESSION', message: 'Open the local workspace to connect its event stream.' } }); return; }
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    const send = (value: unknown) => { response.write(`data: ${JSON.stringify(value)}\n\n`); };
    send({ type: 'snapshot', runs: runtime.manager.history(), connection: runtime.browser.state, activeRunId: runtime.manager.activeRunId });
    const run = (value: unknown) => send({ type: 'run', run: value, activeRunId: runtime.manager.activeRunId });
    const connection = (value: unknown) => send({ type: 'connection', connection: value });
    runtime.manager.on('change', run); runtime.browser.on('change', connection);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    request.on('close', () => { clearInterval(heartbeat); runtime.manager.off('change', run); runtime.browser.off('change', connection); });
  });
  app.use('/api', (_request, response) => { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'This local API route was not found.' } }); });
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof SyntaxError) { response.status(400).json({ error: { code: 'JSON', message: 'The request could not be read. Reload the form and try again.' } }); return; }
    response.status(error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500).json({ error: publicError(error) });
  };
  app.use(errors);
  return app;
}
