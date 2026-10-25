/**
 * A fake server that signs like the real one (SPEC-006 §6), shared by the tests.
 * Not part of the build: tsconfig.build.json leaves src/testing out.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const pair = generateKeyPairSync('ed25519');
const jwk = pair.publicKey.export({ format: 'jwk' });
export const KID = 'test-kid';
export const KEY = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: jwk.x ?? '',
  kid: KID,
  use: 'sig',
  alg: 'EdDSA',
} as const;

export interface BundleOptions {
  readonly policy?: unknown;
  readonly operations?: readonly unknown[];
  readonly issuedAt?: string;
  readonly expiresAt?: string | null;
  readonly organization?: string;
  readonly target?: string;
}

export function bundleBody(options: BundleOptions): string {
  const operations = options.operations ?? [
    {
      op: 'write_file',
      path: '${project}/.claude/rules/ror-hello--context.md',
      content: '# Hello\n<!-- Managed by RunOnRoad — do not edit -->\nNever commit a secret.\n',
    },
    { op: 'git_exclude', pattern: '.claude/rules/ror-*' },
    { op: 'git_exclude', pattern: '.runonroad/lock/' },
  ];
  return JSON.stringify({
    bundle_version: 1,
    capability_matrix_version: '0.1.0',
    degraded: [],
    effective_hash: `sha256:${createHash('sha256').update(JSON.stringify(operations)).digest('hex')}`,
    expires_at: options.expiresAt ?? null,
    issued_at: options.issuedAt ?? '2026-10-17T10:00:00.000Z',
    layer: 'project',
    operations,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    organization_id: options.organization ?? 'org_test',
    project_id: null,
    provenance: [],
    target: options.target ?? 'claude_code',
    warnings: [],
  });
}

export const signature = (body: string, key: KeyObject = pair.privateKey): string =>
  `keyid="${KID}", sig="${sign(null, Buffer.from(body), key).toString('base64url')}"`;

export interface Fake {
  readonly server: Server;
  url: string;
  next: BundleOptions;
  tamper: boolean;
  unauthorized: boolean;
  polls: number;
  requests: { ifNoneMatch: string | undefined }[];
}

export async function fakeServer(): Promise<Fake> {
  const fake: Fake = {
    server: createServer(),
    url: '',
    next: {},
    tamper: false,
    unauthorized: false,
    polls: 0,
    requests: [],
  };
  fake.server.on('request', (request, response) => {
    const send = (code: number, body: string, headers: Record<string, string> = {}): void => {
      response.writeHead(code, { 'content-type': 'application/json', ...headers });
      response.end(body);
    };
    if (request.url === '/v1/devices/authorize') {
      send(
        200,
        JSON.stringify({
          device_code: 'dc',
          user_code: 'BCDF-GHJK',
          verification_uri: 'http://x/device',
          verification_uri_complete: 'http://x/device?user_code=BCDF-GHJK',
          expires_in: 600,
          interval: 0,
        }),
      );
    } else if (request.url === '/v1/devices/token') {
      fake.polls += 1;
      if (fake.polls < 2) {
        send(
          400,
          JSON.stringify({ type: 'x', title: 't', status: 400, code: 'authorization_pending' }),
        );
      } else {
        send(
          200,
          JSON.stringify({
            device_token: `rord_${'a'.repeat(43)}`,
            device_id: `dev_${'0'.repeat(26)}`,
            organization_id: 'org_test',
            signing_public_keys: [KEY],
          }),
        );
      }
    } else if (request.url?.startsWith('/v1/harness') === true) {
      fake.requests.push({ ifNoneMatch: request.headers['if-none-match'] });
      if (fake.unauthorized) {
        send(401, '{}');
        return;
      }
      const body = bundleBody(fake.next);
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      if (request.headers['if-none-match'] === etag) {
        send(304, '', { etag });
        return;
      }
      const sent = fake.tamper ? body.replace('Never commit', 'Always commit') : body;
      send(200, sent, { etag, 'RunOnRoad-Signature': signature(body) });
    } else send(404, '{}');
  });
  await new Promise<void>((done) => fake.server.listen(0, '127.0.0.1', done));
  fake.url = `http://127.0.0.1:${String((fake.server.address() as AddressInfo).port)}`;
  return fake;
}
