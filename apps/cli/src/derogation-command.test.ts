import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from './cli.js';
import { writeLogin } from './state.js';

const SERVER = 'https://ror.example';
const TOKEN = `rord_${'t'.repeat(43)}`;
const ORG = 'org_01J9Z3K8QXV4WN7YBTR2M6ACDE';

let home: string;
let keychain: Map<string, string>;
let sent: Request[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ror-derogation-'));
  keychain = new Map([[SERVER, TOKEN]]);
  sent = [];
  writeLogin(
    home,
    { server: SERVER, organization: ORG, device: 'dev_1' },
    { organization_id: ORG, keys: [] },
  );
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** `ror derogation …` against a server that answers `answer`. */
async function derogation(answer: () => Response, ...args: string[]) {
  const [out, err]: [string[], string[]] = [[], []];
  const code = await run(['derogation', ...args], {
    env: {},
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

describe('ror derogation', () => {
  it('previews a request without any call', async () => {
    const { code, out } = await derogation(
      () => Response.json({}),
      'request',
      'r@1:x',
      '--reason',
      'why',
      '--dry-run',
    );
    expect(code).toBe(0);
    expect(out).toContain('request preview, not sent yet');
    expect(sent).toHaveLength(0);
  });

  it('lists the caller’s own requests with the device token', async () => {
    const { code, out } = await derogation(
      () => Response.json({ items: [], nextCursor: null }),
      'list',
      '--status',
      'granted',
    );
    expect(code).toBe(0);
    expect(out).toBe('');
    expect(sent[0]?.url).toBe(`${SERVER}/v1/derogations?mine=true&status=granted`);
    expect(sent[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses a status that is not one, and a machine that is not signed in', async () => {
    expect((await derogation(() => Response.json({}), 'list', '--status', 'nope')).code).toBe(1);
    keychain.clear();
    const { code, err } = await derogation(() => Response.json({}), 'list');
    expect(code).toBe(11);
    expect(err).toContain('ror login');
    expect(sent).toHaveLength(0);
  });

  it('says its usage when the verb is incomplete', async () => {
    const { code, err } = await derogation(() => Response.json({}), 'request');
    expect(code).toBe(31);
    expect(err).toContain('usage: ror derogation request');
  });
});
