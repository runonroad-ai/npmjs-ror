import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { run } from './cli.js';
import { browserCommand } from './login.js';
import { packageVersion } from './version.js';

const SERVER = 'https://ror.example';
const TOKEN = `rord_${'t'.repeat(43)}`;
const KEY = { kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA' };
const KEYS = ['active', 'recovery'].map((kid) => ({ ...KEY, kid, x: kid }));
const ORG = 'org_01J9Z3K8QXV4WN7YBTR2M6ACDE';
const ENROLLED = {
  status: 200,
  body: {
    device_token: TOKEN,
    device_id: 'dev_01J9Z3K8QXV4WN7YBTR2M6ACDE',
    organization_id: ORG,
    signing_public_keys: KEYS,
  },
};
const CODES = {
  device_code: 'dc',
  user_code: 'BCDF-GHJK',
  verification_uri: `${SERVER}/device`,
  verification_uri_complete: `${SERVER}/device?user_code=BCDF-GHJK`,
  expires_in: 600,
  interval: 1,
};
const problem = (code: string) => ({
  status: 400,
  body: { type: 'about:blank', title: 'x', status: 400, code },
});

let home: string;
let answers: { status: number; body: unknown }[];
let device: Record<string, unknown> | undefined;
let send: typeof fetch;

/** The API, as `fetch` sees it: the codes, then one scripted answer per poll. */
const api = (async (request: Request) => {
  const answer = request.url.endsWith('/v1/devices/authorize')
    ? ((device = (await request.json()) as Record<string, unknown>), { status: 200, body: CODES })
    : (answers.shift() ?? problem('expired_token'));
  return Response.json(answer.body, { status: answer.status });
}) as typeof fetch;

beforeEach(() => {
  send = api;
  home = mkdtempSync(join(tmpdir(), 'ror-login-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function login(...args: string[]) {
  const keychain = new Map<string, string>();
  const [out, err, opened, slept]: [string[], string[], string[], number[]] = [[], [], [], []];
  const code = await run(['login', ...args], {
    env: {},
    home,
    fetch: send,
    keychain,
    sleep: (ms) => Promise.resolve(void slept.push(ms)),
    openBrowser: (page) => opened.push(page),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), keychain, slept, opened };
}

describe('ror login', () => {
  it('enrols once approved: token in the keychain, server, organization and both keys pinned', async () => {
    answers = [problem('authorization_pending'), ENROLLED];
    const { code, out, err, keychain, opened } = await login('--server', SERVER, '--org', 'acme');

    expect(code).toBe(0);
    expect(out).toContain(`Open ${SERVER}/device and enter the code BCDF-GHJK`);
    expect(opened).toEqual([CODES.verification_uri_complete]);
    expect(keychain.get(SERVER)).toBe(TOKEN);
    expect(device).toMatchObject({ organization: 'acme', ror_version: packageVersion() });
    expect(device?.hostname_hash).toMatch(/^[0-9a-f]{64}$/u);
    const state = join(home, '.runonroad');
    expect(parse(readFileSync(join(state, 'config.yaml'), 'utf8'))).toEqual({
      server: SERVER,
      organization: ORG,
      device: ENROLLED.body.device_id,
    });
    expect(JSON.parse(readFileSync(join(state, 'signing-keys.json'), 'utf8'))).toEqual({
      organization_id: ORG,
      keys: KEYS,
    });

    expect(`${out}\n${err}`).not.toContain(TOKEN);
    const files = readdirSync(home, { recursive: true, withFileTypes: true }).filter((e) =>
      e.isFile(),
    );
    expect(files).toHaveLength(2);
    for (const file of files)
      expect(readFileSync(join(file.parentPath, file.name), 'utf8')).not.toContain(TOKEN);
  });

  it('exits 10 with a ROR-E code when the code is denied', async () => {
    answers = [problem('access_denied')];
    const { code, err, keychain } = await login('--server', SERVER);
    expect([code, keychain.size]).toEqual([10, 0]);
    expect(err).toMatch(/^ROR-E113 /u);
  });

  it('exits 11 and says to run ror login again when the code expires', async () => {
    answers = [problem('authorization_pending'), problem('expired_token')];
    const { code, err } = await login('--server', SERVER);
    expect(code).toBe(11);
    expect(err).toMatch(/^ROR-E114 .*Run `ror login` again/u);
  });

  it('widens the interval by 5 s on slow_down, and opens no browser with --non-interactive', async () => {
    answers = [problem('slow_down'), problem('slow_down'), ENROLLED];
    const { code, slept, opened } = await login('--server', SERVER, '--non-interactive');
    expect(code).toBe(0);
    expect(slept).toEqual([1000, 6000, 11000]);
    expect(opened).toEqual([]);
  });

  it('exits 1 with ROR-E117 naming the server when it cannot be reached', async () => {
    send = () => Promise.reject(new TypeError('fetch failed'));
    const { code, err } = await login('--server', SERVER);
    expect(code).toBe(1);
    expect(err).toMatch(/^ROR-E117 https:\/\/ror\.example cannot be reached .*--server/u);
  });

  it.each([
    ['a token answer that fails the schema', { status: 200, body: { device_token: TOKEN } }],
    ['a problem code RFC 8628 does not define', problem('server_error')],
  ])('exits 1 with ROR-E115 on %s, storing nothing', async (_, answer) => {
    answers = [answer];
    const { code, err, keychain } = await login('--server', SERVER);
    expect([code, keychain.size]).toEqual([1, 0]);
    expect(err).toMatch(/^ROR-E115 /u);
    expect(err).not.toContain(TOKEN);
    expect(readdirSync(home)).toEqual([]);
  });

  it('refuses to start without a server, then reuses the one a login recorded', async () => {
    expect((await login()).err).toContain('ROR-E112');
    answers = [ENROLLED, ENROLLED];
    await login('--server', SERVER);
    expect((await login()).code).toBe(0);
  });
});

describe('browserCommand', () => {
  it('passes the address as one argument, never to a shell, and opens only http(s)', () => {
    const page = 'https://x.example/device?user_code=A&calc';
    expect(browserCommand(page, 'win32')).toEqual([
      'rundll32',
      ['url.dll,FileProtocolHandler', page],
    ]);
    expect(browserCommand(page, 'darwin')).toEqual(['open', [page]]);
    expect(browserCommand(page, 'linux')).toEqual(['xdg-open', [page]]);
    expect(browserCommand('file:///etc/passwd', 'darwin')).toBeUndefined();
  });
});
