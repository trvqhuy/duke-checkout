// ---------------------------------------------------------------------------
// chip-demo — a local page for eyeballing the hover card
// ---------------------------------------------------------------------------
// Serves demo/chips.html on 127.0.0.1 so the extension's <all_urls> content
// script actually injects (file:// pages need the "Allow access to file URLs"
// toggle). The page contains real BIG W product links, a variant-suffixed link,
// a long title, a non-product link, and a link inserted after two seconds.
//
// Usage: npm run demo:chips [-- --open]
// `--open` asks the desktop to open the URL in the default browser.
// ---------------------------------------------------------------------------
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = resolve(root, 'demo/chips.html');
const port = Number(process.env.PORT ?? 4321);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname !== '/' && url.pathname !== '/chips' && url.pathname !== '/chips.html') {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found. Open / for the chip demo.');
    return;
  }
  try {
    const html = await readFile(pagePath, 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(`Could not read ${pagePath}: ${String(error)}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Duke chip demo: ${url}`);
  console.log('Hover a product title or image. Keep the extension loaded and enabled.');
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [url], error => { if (error) console.log(`Open it manually: ${url}`); });
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(() => process.exit(0)); });
}
