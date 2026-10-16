import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { discoverEndpoint } from '../src/server/browser/connection.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('existing Chrome discovery', () => {
  it('uses an explicitly configured WebSocket without HTTP discovery', async () => {
    const endpoint = 'ws://127.0.0.1:9222/devtools/browser/example';
    expect(await discoverEndpoint({ endpoint })).toBe(endpoint);
  });

  it('reads the current browser endpoint from its profile', async () => {
    const dir = await mkdtemp('/tmp/opencode/duke-connection-'); directories.push(dir);
    await writeFile(`${dir}/DevToolsActivePort`, '9222\n/devtools/browser/current-browser\n');
    expect(await discoverEndpoint({ userDataDir: dir })).toBe('ws://127.0.0.1:9222/devtools/browser/current-browser');
  });

  it.each(['0\n/devtools/browser/id', '99999\n/devtools/browser/id', '9222\nhttps://other.example', 'not-a-port\n/devtools/browser/id'])('rejects malformed discovery data', async contents => {
    const dir = await mkdtemp('/tmp/opencode/duke-connection-'); directories.push(dir);
    await writeFile(`${dir}/DevToolsActivePort`, contents);
    await expect(discoverEndpoint({ userDataDir: dir })).rejects.toThrow();
  });

  it('explains the Chrome setup when the profile is unavailable', async () => {
    await expect(discoverEndpoint({ userDataDir: '/tmp/opencode/duke-missing-profile' })).rejects.toThrow(/remote debugging/i);
  });
});
