import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const [port, path] = readFileSync('/home/huyvtrinh/.config/google-chrome/DevToolsActivePort','utf8').trim().split(/\r?\n/);
const endpoint = `ws://127.0.0.1:${port}${path}`;
console.log('endpoint', endpoint);
const t = setTimeout(() => console.log('browserWSEndpoint -> TIMEOUT(20s)'), 20000);
try {
  const b = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null, protocolTimeout: 12000 });
  clearTimeout(t);
  console.log('browserWSEndpoint -> CONNECTED', await b.version(), 'pages:', (await b.pages()).length);
  await b.disconnect();
} catch (e) { clearTimeout(t); console.log('browserWSEndpoint -> FAIL', e.message); }
