import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from './cli.js';

const SERVER = 'https://ror.example';
const fresh = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const DEVICE = fresh('rord');
const PERSONAL = fresh('rorp');
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  },
};
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const RESULT = { jsonrpc: '2.0', id: 1, result: { ok: true } };

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ror-mcp-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Seen {
  url: string;
  authorization: string | null;
  body: unknown;
}

/** `ror mcp` fed `messages`; `answer` is the server, `keychain` what the device holds. */
async function relay(
  messages: unknown[],
  options: {
    env?: Record<string, string>;
    keychain?: Map<string, string>;
    answer: (request: Request, seen: Seen[]) => Response | Promise<Response>;
  },
) {
  const [out, err]: [string[], string[]] = [[], []];
  const seen: Seen[] = [];
  const keychain = options.keychain ?? new Map<string, string>();
  const code = await run(['mcp', '--server', SERVER], {
    env: options.env ?? {},
    home,
    keychain,
    fetch: (async (request: Request) => {
      const text = request.method === 'POST' ? await request.clone().text() : '';
      seen.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        body: text === '' ? undefined : JSON.parse(text),
      });
      return options.answer(request, seen);
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
    openBrowser: () => undefined,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    input: Readable.from(messages.map((message) => `${JSON.stringify(message)}\n`)),
  } as never);
  return { code, out, err, seen, keychain };
}

const isRpc = (line: string) => {
  const parsed = JSON.parse(line) as { jsonrpc?: string };
  return parsed.jsonrpc === '2.0';
};

describe('ror mcp', () => {
  it('relays each message to /mcp with the device token of the keychain, and writes only JSON-RPC', async () => {
    const { code, out, err, seen } = await relay([INIT, LIST], {
      keychain: new Map([[SERVER, DEVICE]]),
      answer: () => Response.json(RESULT),
    });
    expect(code).toBe(0);
    expect(seen.map((one) => one.url)).toEqual([`${SERVER}/mcp`, `${SERVER}/mcp`]);
    expect(seen.every((one) => one.authorization === `Bearer ${DEVICE}`)).toBe(true);
    expect(seen.map((one) => one.body)).toEqual([INIT, LIST]);
    expect(out).toHaveLength(2);
    expect(out.every(isRpc)).toBe(true);
    expect([...out, ...err].join('\n')).not.toContain(DEVICE);
  });

  it('reads the events of a stream answer, and says nothing for a notification', async () => {
    const { out } = await relay([{ jsonrpc: '2.0', method: 'notifications/initialized' }, INIT], {
      keychain: new Map([[SERVER, DEVICE]]),
      answer: (_request, seen) =>
        seen.length === 1
          ? new Response(null, { status: 202 })
          : new Response(`event: message\ndata: ${JSON.stringify(RESULT)}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            }),
    });
    expect(out).toEqual([JSON.stringify(RESULT)]);
  });

  it('sends RUNONROAD_TOKEN unchanged, over the keychain, and never starts an enrolment', async () => {
    const { out, seen, keychain } = await relay([INIT], {
      env: { RUNONROAD_TOKEN: PERSONAL },
      keychain: new Map([[SERVER, DEVICE]]),
      answer: () => Response.json(RESULT),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe(`Bearer ${PERSONAL}`);
    expect(out).toEqual([JSON.stringify(RESULT)]);
    expect(keychain.get(SERVER)).toBe(DEVICE);
  });

  it('answers a JSON-RPC error that says to run `ror login` on a 401, and leaves the stored token', async () => {
    const { out, keychain, seen } = await relay([INIT], {
      keychain: new Map([[SERVER, DEVICE]]),
      answer: () => new Response(null, { status: 401 }),
    });
    expect(seen).toHaveLength(1);
    const answer = JSON.parse(out[0] ?? '{}') as { id: number; error: { message: string } };
    expect(answer.id).toBe(1);
    expect(answer.error.message).toContain('ror login');
    expect(keychain.get(SERVER)).toBe(DEVICE);
  });

  it('answers a JSON-RPC error for each request when the server is unreachable, naming no address', async () => {
    const { out, err } = await relay([INIT, LIST], {
      keychain: new Map([[SERVER, DEVICE]]),
      answer: () => {
        throw new TypeError(`fetch failed for ${SERVER} with ${DEVICE}`);
      },
    });
    expect(out).toHaveLength(2);
    for (const line of out)
      expect((JSON.parse(line) as { error: { message: string } }).error.message).toBe(
        'RunOnRoad is unreachable.',
      );
    expect([...out, ...err].join('\n')).not.toContain(DEVICE);
  });

  it('starts the enrolment on the first message when there is no token, then forwards it', async () => {
    const enrolled = {
      device_token: DEVICE,
      device_id: `dev_${'0'.repeat(26)}`,
      organization_id: `org_${'0'.repeat(26)}`,
      signing_public_keys: ['active', 'recovery'].map((kid) => ({
        kty: 'OKP',
        crv: 'Ed25519',
        use: 'sig',
        alg: 'EdDSA',
        kid,
        x: kid,
      })),
    };
    const { out, err, seen, keychain } = await relay([INIT], {
      answer: (request) =>
        request.url.endsWith('/v1/devices/authorize')
          ? Response.json({
              device_code: 'dc',
              user_code: 'BCDF-GHJK',
              verification_uri: `${SERVER}/device`,
              verification_uri_complete: `${SERVER}/device?user_code=BCDF-GHJK`,
              expires_in: 600,
              interval: 1,
            })
          : request.url.endsWith('/v1/devices/token')
            ? Response.json(enrolled)
            : Response.json(RESULT),
    });
    expect(keychain.get(SERVER)).toBe(DEVICE);
    expect(err.join('\n')).toContain('BCDF-GHJK');
    expect(out).toEqual([JSON.stringify(RESULT)]);
    expect(seen.at(-1)?.url).toBe(`${SERVER}/mcp`);
    expect(seen.at(-1)?.authorization).toBe(`Bearer ${DEVICE}`);
  });
});
