// Release packer for the Duke Checkout extension.
//
// WHAT THIS DOES
//   Builds dist-extension/, copies it to a temp dir, optionally injects
//   "update_url" into the copied manifest, then asks Chrome itself to produce a
//   signed .crx via `chrome --pack-extension`. The result is written to
//   release/duke-checkout.crx together with release/update.xml for Chrome's
//   self-hosted auto-update.
//
// KEY CUSTODY — READ THIS BEFORE RUNNING
//   The Chrome extension ID is derived from the private key at
//   ./duke-extension.pem (or DUKE_CRX_KEY). The .pem is the identity of the
//   extension:
//     * Keep it SECRET. Anyone with the key can sign a build that updates
//       every installed copy.
//     * NEVER regenerate it. A new key means a new extension ID: every friend
//       install becomes a different extension that will never receive updates,
//       and their settings/session state do not carry over.
//     * Back it up somewhere safe and private (not in git — *.pem is ignored).
//   If the key is missing this script asks Chrome to mint one and moves it to
//   ./duke-extension.pem, then prints a loud warning. That is a first-release
//   convenience, not a routine action.
//
// update_url IS INJECTED ONLY FOR RELEASE PACKS
//   The checked-in src/extension/manifest.json never contains update_url, so
//   unpacked developer builds (`npm run build:ext` → Load unpacked) do not try
//   to self-update. When DUKE_UPDATE_URL is set the copied manifest gets
//   "update_url" pointing at the hosted update.xml. When it is unset the build
//   is a local/test pack: it will NOT auto-update, and no update.xml is written
//   because there is no host to point at.

import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const DIST_DIR = resolve('dist-extension');
const MANIFEST_SRC = resolve('src/extension/manifest.json');
const RELEASE_DIR = resolve('release');
const DEFAULT_KEY = resolve('duke-extension.pem');
const CRX_NAME = 'duke-checkout.crx';
const UPDATE_XML_NAME = 'update.xml';

// The canonical Chrome extension-ID algorithm: sha256 the DER-encoded
// SubjectPublicKeyInfo, keep the first 16 bytes, and map each hex nibble to
// 'a' + nibble (0-9 → a-j, a-f → k-p). That yields a 32-char a-p id.
export function extensionIdFromPublicKey(der: Buffer): string {
  const digest = createHash('sha256').update(der).digest();
  return Array.from(digest.subarray(0, 16), byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f))).join('');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// Chrome's self-hosted update manifest. Chrome fetches this document and
// compares <updatecheck version> with the installed extension version.
export function updateXml(appId: string, version: string, crxUrl: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
    `  <app appid="${escapeXml(appId)}">`,
    `    <updatecheck codebase="${escapeXml(crxUrl)}" version="${escapeXml(version)}" />`,
    '  </app>',
    '</gupdate>',
    '',
  ].join('\n');
}

function runBuild(): void {
  const result = spawnSync('npm', ['run', 'build:ext'], { stdio: 'inherit' });
  if (result.error) throw new Error(`Could not start the extension build: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`The extension build (npm run build:ext) failed with exit code ${result.status}.`);
  if (!existsSync(join(DIST_DIR, 'manifest.json'))) throw new Error('The build finished but dist-extension/manifest.json is missing.');
}

function injectUpdateUrl(manifestPath: string, updateUrl: string): void {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.update_url = updateUrl;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function resolveChrome(): Promise<string> {
  const configured = process.env.CHROME_PATH;
  if (configured) {
    if (existsSync(configured)) return configured;
    throw new Error(`CHROME_PATH is set but does not exist: ${configured}`);
  }
  try {
    const resolved = await puppeteer.executablePath('chrome');
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // No puppeteer-known Chrome (the integration harness uses channel: 'chrome');
    // fall through to the common system locations.
  }
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome/Chromium executable found. Set CHROME_PATH or install google-chrome/chromium.');
}

function packWithChrome(chromePath: string, extensionDir: string, keyPath: string | undefined): void {
  const args = [`--pack-extension=${extensionDir}`];
  if (keyPath) args.push(`--pack-extension-key=${keyPath}`);
  const result = spawnSync(chromePath, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`Could not start Chrome to pack the extension: ${result.error.message}`);
  const detail = [result.stdout, result.stderr].map(text => text?.trim()).filter(Boolean).join('\n');
  if (result.status !== 0) {
    throw new Error([`Chrome failed to pack the extension (exit ${result.status}${result.signal ? `, signal ${result.signal}` : ''}).`, detail].filter(Boolean).join('\n'));
  }
  // Chrome prints a benign directory warning on stderr even on success.
  if (detail) console.log(detail);
}

// Moves a file even when source and destination are on different filesystems
// (Chrome writes into /tmp while the repo may live on another device).
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

function readManifestVersion(): string {
  const manifest = JSON.parse(readFileSync(MANIFEST_SRC, 'utf8')) as { version?: string };
  if (!manifest.version) throw new Error('src/extension/manifest.json has no version.');
  return manifest.version;
}

export async function main(): Promise<void> {
  const updateUrl = process.env.DUKE_UPDATE_URL?.trim();
  if (!updateUrl) {
    console.warn('WARNING: DUKE_UPDATE_URL is not set — packing WITHOUT update_url.');
    console.warn('WARNING: this build will NOT auto-update. Set DUKE_UPDATE_URL for a release pack.');
  }

  const keyPath = resolve(process.env.DUKE_CRX_KEY ?? DEFAULT_KEY);
  const chromePath = await resolveChrome();
  const version = readManifestVersion();

  runBuild();

  const tempRoot = mkdtempSync('/tmp/opencode/duke-pack-');
  const extensionDir = join(tempRoot, 'duke-checkout');
  try {
    cpSync(DIST_DIR, extensionDir, { recursive: true });
    if (updateUrl) injectUpdateUrl(join(extensionDir, 'manifest.json'), updateUrl);

    const hadKey = existsSync(keyPath);
    packWithChrome(chromePath, extensionDir, hadKey ? keyPath : undefined);

    if (!hadKey) {
      const generated = `${extensionDir}.pem`;
      if (!existsSync(generated)) throw new Error(`Chrome did not write a key at ${generated}.`);
      moveFile(generated, keyPath);
      console.warn('');
      console.warn('==================================================================');
      console.warn(' A NEW SIGNING KEY WAS CREATED: ' + keyPath);
      console.warn(' KEEP THIS FILE SECRET AND NEVER REGENERATE IT.');
      console.warn(' It is the extension identity: regenerating it changes the');
      console.warn(' extension ID and breaks every existing install and update.');
      console.warn(' Back it up somewhere private. It is gitignored (*.pem).');
      console.warn('==================================================================');
      console.warn('');
    }

    const generatedCrx = `${extensionDir}.crx`;
    if (!existsSync(generatedCrx)) throw new Error(`Chrome did not write a CRX at ${generatedCrx}.`);

    const privateKey = createPrivateKey(readFileSync(keyPath));
    const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
    const extensionId = extensionIdFromPublicKey(publicDer);

    mkdirSync(RELEASE_DIR, { recursive: true });
    const crxOut = join(RELEASE_DIR, CRX_NAME);
    moveFile(generatedCrx, crxOut);

    console.log('');
    console.log(`Extension ID: ${extensionId}`);
    console.log(`Version:      ${version}`);
    console.log(`CRX:          ${crxOut}`);

    if (updateUrl) {
      const crxUrl = new URL(CRX_NAME, updateUrl).href;
      const xmlPath = join(RELEASE_DIR, UPDATE_XML_NAME);
      writeFileSync(xmlPath, updateXml(extensionId, version, crxUrl));
      console.log(`update.xml:   ${xmlPath}`);
      console.log(`CRX URL:      ${crxUrl}`);
    } else {
      console.log('update.xml:   skipped (no DUKE_UPDATE_URL — local/test pack only).');
    }

    console.log('');
    console.log('Next steps:');
    console.log(`  1. Upload release/${CRX_NAME}${updateUrl ? ` and release/${UPDATE_XML_NAME}` : ''} to the static host${updateUrl ? ` (the directory served by ${updateUrl})` : ''}.`);
    console.log('  2. Tell the group; Chrome checks update.xml every few hours.');
    console.log('  3. Bump the version in src/extension/manifest.json before the next release.');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
