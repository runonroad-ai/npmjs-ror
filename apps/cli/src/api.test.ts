import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiClient } from './api.js';
import { type KeychainBackend, tokenStore } from './token-store.js';

interface Stub {
  url: string;
  seen: IncomingHttpHeaders[];
  server: Server;
}

async function stub(): Promise<Stub> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: [], nextCursor: null }));
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, seen, server };
}

const backend = (entries: Record<string, string>): KeychainBackend => ({
  get: (account) => entries[account],
  set: () => undefined,
  delete: () => false,
});

let issuer: Stub;
let foreign: Stub;

beforeAll(async () => {
  [issuer, foreign] = await Promise.all([stub(), stub()]);
});

afterAll(() => {
  issuer.server.close();
  foreign.server.close();
});

async function authorizationSeenBy(target: Stub, tokens: ReturnType<typeof tokenStore>) {
  await apiClient({ server: target.url, tokens }).GET('/organization/signing-keys');
  return target.seen.at(-1)?.authorization;
}

describe('the token goes only to the origin that issued it', () => {
  const tokens = () =>
    tokenStore({
      configuredServer: issuer.url,
      env: {},
      backend: backend({ [issuer.url]: 'tok' }),
    });

  it('sends the bearer token to the server on the token origin', async () => {
    expect(await authorizationSeenBy(issuer, tokens())).toBe('Bearer tok');
  });

  it('sends no Authorization header to a server on another origin', async () => {
    expect(await authorizationSeenBy(foreign, tokens())).toBeUndefined();
  });

  it('does not follow a per-call baseUrl with the token', async () => {
    await apiClient({ server: issuer.url, tokens: tokens() }).GET('/organization/signing-keys', {
      baseUrl: `${foreign.url}/v1`,
    });
    expect(foreign.seen.at(-1)?.authorization).toBeUndefined();
  });

  it('does not carry the token across a redirect to another origin', async () => {
    const redirector = createServer((_request, response) => {
      response.writeHead(307, { location: `${foreign.url}/v1/organization/signing-keys` }).end();
    });
    await new Promise<void>((listening) => redirector.listen(0, '127.0.0.1', listening));
    const { port } = redirector.address() as AddressInfo;
    const origin = `http://127.0.0.1:${String(port)}`;
    const before = foreign.seen.length;
    const store = tokenStore({
      configuredServer: origin,
      env: {},
      backend: backend({ [origin]: 'tok' }),
    });
    try {
      await apiClient({ server: origin, tokens: store }).GET('/organization/signing-keys');
    } finally {
      redirector.close();
    }
    expect(foreign.seen.length).toBe(before + 1);
    expect(foreign.seen.at(-1)?.authorization).toBeUndefined();
  });
});

describe('RUNONROAD_TOKEN is bound to the configured server', () => {
  const tokens = () =>
    tokenStore({
      configuredServer: issuer.url,
      env: { RUNONROAD_TOKEN: 'agent-tok' },
      backend: backend({ [foreign.url]: 'keychain-tok' }),
    });

  it('is attached for the configured server', async () => {
    expect(await authorizationSeenBy(issuer, tokens())).toBe('Bearer agent-tok');
  });

  it('is never attached for a URL read from a repository file', async () => {
    expect(await authorizationSeenBy(foreign, tokens())).toBeUndefined();
  });
});

describe('only api.ts sends HTTP requests', () => {
  const SENDS_HTTP = [
    /\bfetch\s*\(/u,
    /globalThis\.fetch\b/u,
    /from\s+['"](?:node:)?https?['"]/u,
    /import\(\s*['"](?:node:)?https?['"]\s*\)/u,
    /require\(\s*['"](?:node:)?https?['"]\s*\)/u,
  ];
  const sendsHttp = (source: string) => SENDS_HTTP.some((pattern) => pattern.test(source));

  it('recognises a fetch call and an http import', () => {
    expect(sendsHttp("await fetch('https://x')")).toBe(true);
    expect(sendsHttp("import { request } from 'node:https';")).toBe(true);
    expect(sendsHttp("import http from 'http';")).toBe(true);
    expect(sendsHttp('fetch?: typeof fetch;')).toBe(false);
  });

  it('finds no other module of apps/cli that does', () => {
    const src = new URL('./', import.meta.url);
    // Windows lists `testing\\x.ts`: one spelling for the match
    const offenders = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .map((file) => file.replaceAll('\\', '/'))
      .filter(
        (file) =>
          /\.[cm]?[jt]s$/u.test(file) &&
          !/\.test\.[cm]?[jt]s$/u.test(file) &&
          !file.startsWith('testing/'),
      )
      .filter((file) => file !== 'api.ts')
      .filter((file) => sendsHttp(readFileSync(new URL(file, src), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
