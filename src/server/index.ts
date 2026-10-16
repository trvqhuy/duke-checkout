import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.ts';
import { BrowserConnection } from './browser/connection.ts';
import { BigWAdapter } from './browser/bigw.ts';
import { RunManager } from './checkout.ts';
import { LocalStore } from './storage.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
const production = process.argv.includes('--production');
const store = new LocalStore(resolve(process.env.DATA_DIR ?? 'data'));
const browser = new BrowserConnection();
const adapter = new BigWAdapter(browser);
const manager = new RunManager(store, adapter);
await manager.init();
const token = await store.localToken();
const app = createApp({ store, browser, adapter, manager, token });
const server = createServer(app);

if (production) {
  if (!existsSync('dist/index.html')) throw new Error('Build the web form first with npm run build.');
  app.use(express.static(resolve('dist')));
  app.use((_request, response) => response.sendFile(resolve('dist/index.html')));
} else {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({ server: { middlewareMode: true, ws: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}

server.listen(port, '127.0.0.1', () => console.log(`Duke Checkout is running at http://127.0.0.1:${port}`));
server.on('error', () => { console.error('The local server could not start. Check that PORT is available.'); process.exitCode = 1; });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  if (manager.activeRunId) { try { manager.cancel(manager.activeRunId); } catch { /* Submitted runs retain their durable recovery marker. */ } }
  await browser.disconnect();
  server.closeAllConnections(); server.close();
  if (manager.activeRunId) await Promise.race([manager.wait(manager.activeRunId), new Promise(resolve => setTimeout(resolve, 1500))]);
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
