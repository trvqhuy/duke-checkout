import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extensionIdFromPublicKey, updateXml } from '../scripts/pack-extension.ts';

// Chrome's extension ID algorithm, documented here so the vector below is
// checked against the specification rather than against the implementation:
//   sha256(SPKI DER) -> first 16 bytes -> nibble 'a' + value.
function documentedId(bytes: Buffer): string {
  const digest = createHash('sha256').update(bytes).digest().subarray(0, 16);
  let id = '';
  for (const byte of digest) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

describe('extension id', () => {
  it('derives a 32-character a-p id from a real SPKI public key', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const id = extensionIdFromPublicKey(der);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(id).toBe(documentedId(der));
  });

  it('matches a deterministic vector', () => {
    // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    // first 16 bytes -> nibbles a-p -> the id below.
    const vector = Buffer.from('hello');
    expect(extensionIdFromPublicKey(vector)).toBe('cmpcenlkfplakdaocgoidlckmfljocjo');
    expect(documentedId(vector)).toBe('cmpcenlkfplakdaocgoidlckmfljocjo');
  });
});

describe('updateXml', () => {
  it('emits the standard self-hosted update document', () => {
    const xml = updateXml('abcdefghijklmnopabcdefghijklmnop', '1.2.3', 'https://host.example/duke/duke-checkout.crx');
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">\n' +
        '  <app appid="abcdefghijklmnopabcdefghijklmnop">\n' +
        '    <updatecheck codebase="https://host.example/duke/duke-checkout.crx" version="1.2.3" />\n' +
        '  </app>\n' +
        '</gupdate>\n',
    );
  });

  it('XML-escapes the codebase URL', () => {
    const xml = updateXml('id', '0.1.0', 'https://host.example/duke.crx?a=1&b="two"&c=<\'x\'>');
    expect(xml).toContain('codebase="https://host.example/duke.crx?a=1&amp;b=&quot;two&quot;&amp;c=&lt;&apos;x&apos;&gt;"');
  });
});

describe('manifest version', () => {
  it('matches the release version shape', () => {
    const manifest = JSON.parse(readFileSync(new URL('../src/extension/manifest.json', import.meta.url), 'utf8')) as { version: string };
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
