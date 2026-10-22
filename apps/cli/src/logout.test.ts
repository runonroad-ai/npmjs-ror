import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from './cli.js';
import { writeLogin } from './state.js';

const SERVER = 'https://ror.example';
const TOKEN = `rord_${'t'.repeat(43)}`;
const DEVICE = 'dev_01J9Z3K8QXV4WN7YBTR2M6ACDE';
const ORG = 'org_01J9Z3K8QXV4WN7YBTR2M6ACDE';

let home: string;
let keychain: Map<string, string>;
let sent: Request[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ror-logout-'));
  keychain = new Map([[SERVER, TOKEN]]);
  sent = [];
  writeLogin(
    home,
    { server: SERVER, organization: ORG, device: DEVICE },
    { organization_id: ORG, keys: [] },
  );
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** `ror logout`, against a server that answers `answer` (or cannot be reached when it throws). */
async function logout(answer: () => Response, ...args: string[]) {
  const [out, err]: [string[], string[]] = [[], []];
  const code = await run(['logout', ...args], {
    env: { RUNONROAD_TOKEN: 'rora_agent' },
    home,
    keychain,
    fetch: ((request: Request) => {
      sent.push(request);
      return Promise.resolve().then(answer);
    }) as typeof fetch,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('ror logout', () => {
  it('revokes the device with its own token, then removes the keychain entry', async () => {
    const { code, out, err } = await logout(() => new Response(null, { status: 204 }));

    expect(code).toBe(0);
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      `DELETE ${SERVER}/v1/devices/${DEVICE}`,
    ]);
    // The device's own token, never the agent token of the environment.
    expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(keychain.size).toBe(0);
    expect(out).toBe(`Device ${DEVICE} revoked. Signed out of ${SERVER}.`);
    expect(err).toBe('');
  });

  it('still removes the keychain entry when the server is unreachable, and says to revoke in the console', async () => {
    const { code, err } = await logout(() => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    });

    expect(code).toBe(0);
    expect(keychain.size).toBe(0);
    expect(err).toContain('ROR-E118');
    expect(err).toContain('ECONNREFUSED');
    expect(err).toContain('revoke the device from your profile in the console');
  });

  it('still removes the keychain entry when the server refuses, and says to revoke in the console', async () => {
    const { code, err } = await logout(() =>
      Response.json({ code: 'device_not_found' }, { status: 404 }),
    );

    expect(code).toBe(0);
    expect(keychain.size).toBe(0);
    expect(err).toContain(`${SERVER} answered 404`);
    expect(err).toContain('revoke the device from your profile in the console');
  });

  it('does not send the recorded device id to another server than the one it was enrolled on', async () => {
    const other = 'https://other.example';
    keychain.set(other, TOKEN);
    const { code, err } = await logout(
      () => new Response(null, { status: 204 }),
      '--server',
      other,
    );

    expect(code).toBe(0);
    expect(sent).toEqual([]);
    expect([...keychain.keys()]).toEqual([SERVER]);
    expect(err).toContain('revoke the device from your profile in the console');
  });

  it('says nothing is signed in, and exits 0, when no token is stored', async () => {
    keychain.clear();
    const { code, out } = await logout(() => new Response(null, { status: 204 }));

    expect(code).toBe(0);
    expect(out).toBe(`Nothing is signed in to ${SERVER}.`);
    expect(sent).toEqual([]);
  });

  it('says nothing is signed in, and exits 0, when no server was ever configured', async () => {
    rmSync(join(home, '.runonroad'), { recursive: true });
    const { code, out } = await logout(() => new Response(null, { status: 204 }));

    expect(code).toBe(0);
    expect(out).toBe('Nothing is signed in: no server configured.');
    expect(sent).toEqual([]);
  });
});
