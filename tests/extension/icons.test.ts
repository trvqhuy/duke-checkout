import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const iconsDir = resolve(root, 'src/extension/icons');
const sourceManifest = resolve(root, 'src/extension/manifest.json');
const distDir = resolve(root, 'dist-extension');

function pngDimensions(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Every .png string anywhere in the manifest (icons map + action.default_icon).
function collectIconPaths(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') { if (value.endsWith('.png')) out.push(value); }
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) collectIconPaths(entry, out);
  return out;
}

describe('extension icons', () => {
  it('ships valid square PNGs at 16, 48, and 128', () => {
    for (const size of [16, 48, 128]) {
      expect(pngDimensions(resolve(iconsDir, `icon${size}.png`))).toEqual({ width: size, height: size });
    }
  });

  it('declares icon paths that exist in the source tree', () => {
    const paths = collectIconPaths(JSON.parse(readFileSync(sourceManifest, 'utf8')));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(resolve(root, 'src/extension', path)), `${path} is missing`).toBe(true);
  });

  it('emits every declared icon into dist-extension after a build', () => {
    const distManifest = resolve(distDir, 'manifest.json');
    if (!existsSync(distManifest)) return; // build:ext has not run yet
    for (const path of collectIconPaths(JSON.parse(readFileSync(distManifest, 'utf8')))) {
      expect(existsSync(resolve(distDir, path)), `${path} is missing from dist-extension`).toBe(true);
    }
  });
});
