// `ror login [--server <url>] [--org <slug>] [--non-interactive]` (SPEC-007 §2), by RFC 8628.
// The token goes to the keychain only, never to stdout, stderr or a file.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch, hostname, platform } from 'node:os';
import { setTimeout as sleepFor } from 'node:timers/promises';

import type { Problem } from '@runonroad/api-contract';
import { DeviceTokenSchema } from '@runonroad/api-contract/device-token';

import { apiClient } from './api.js';
import type { Output } from './cli.js';
import { flagValue } from './flags.js';
import { resolveServer, writeLogin } from './state.js';
import { type KeychainBackend, RorError, tokenStore } from './token-store.js';
import { packageVersion } from './version.js';

/** What `ror login` needs from the machine; tests inject every one of them. */
export interface LoginContext extends Output {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  fetch?: typeof fetch;
  keychain?: KeychainBackend;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => void;
}

/** RFC 8628 §3.5: what `slow_down` adds to the polling interval. */
const SLOW_DOWN_SECONDS = 5;
type Os = 'darwin' | 'linux' | 'windows';
const OS: Partial<Record<string, Os>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const ARCH: Partial<Record<string, 'amd64' | 'arm64'>> = { x64: 'amd64', arm64: 'arm64' };

/** The command that opens a page, never through a shell: the URL is an argument, not a command line. */
export function browserCommand(url: string, os: NodeJS.Platform): [string, string[]] | undefined {
  const protocol = URL.parse(url)?.protocol;
  if (protocol !== 'https:' && protocol !== 'http:') return undefined;
  if (os === 'darwin') return ['open', [url]];
  if (os === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

function openBrowser(url: string): void {
  const command = browserCommand(url, platform());
  // Without a display there is nothing to open: the address is printed, and that is enough.
  if (command !== undefined)
    spawn(...command, { stdio: 'ignore', detached: true })
      .on('error', () => undefined)
      .unref();
}

function describeDevice(org: string | undefined) {
  const [os, cpu] = [OS[platform()], ARCH[arch()]];
  if (os === undefined || cpu === undefined) {
    throw new RorError('ROR-E116', `This platform (${platform()} ${arch()}) cannot be enrolled.`);
  }
  return {
    os,
    arch: cpu,
    ror_version: packageVersion(),
    hostname_hash: createHash('sha256').update(hostname()).digest('hex'),
    ...(org === undefined ? {} : { organization: org }),
  };
}

const unexpected = (server: string, detail: string) =>
  new RorError(
    'ROR-E115',
    `${server} answered unexpectedly (${detail}). Check --server and retry.`,
  );

/** Exit codes (SPEC-007 §2): 0 enrolled, 10 denied, 11 expired. */
export async function login(args: readonly string[], context: LoginContext): Promise<number> {
  const server = resolveServer(args, context.home);
  const { keychain: backend, fetch } = context;
  const tokens = tokenStore({
    configuredServer: server,
    env: context.env,
    ...(backend && { backend }),
  });
  const client = apiClient({ server, tokens, ...(fetch && { fetch }) });
  const sleep = context.sleep ?? ((ms: number) => sleepFor(ms));

  const device = describeDevice(flagValue(args, '--org'));
  const { data: codes, response } = await client.POST('/devices/authorize', { body: device });
  if (codes === undefined) throw unexpected(server, String(response.status));

  context.out(`Open ${codes.verification_uri} and enter the code ${codes.user_code}`);
  if (!args.includes('--non-interactive')) {
    (context.openBrowser ?? openBrowser)(codes.verification_uri_complete);
  }

  let interval = codes.interval;
  for (let waited = 0; waited < codes.expires_in; waited += interval) {
    await sleep(interval * 1000);
    const poll = await client.POST('/devices/token', { body: { device_code: codes.device_code } });
    if (poll.data !== undefined) {
      const enrolled = DeviceTokenSchema.safeParse(poll.data);
      if (!enrolled.success) throw unexpected(server, 'malformed token answer');
      const { device_token, device_id, organization_id, signing_public_keys } = enrolled.data;
      tokens.set(server, device_token);
      writeLogin(
        context.home,
        { server, organization: organization_id, device: device_id },
        { organization_id, keys: signing_public_keys },
      );
      context.out(`Device ${device_id} enrolled in ${organization_id}.`);
      return 0;
    }
    // A proxy or a crash can answer something else than a problem document.
    const code = (poll.error as Partial<Problem> | undefined)?.code;
    if (code === 'slow_down') interval += SLOW_DOWN_SECONDS;
    else if (code === 'access_denied') {
      context.err('ROR-E113 The device was denied in the console. Run `ror login` to ask again.');
      return 10;
    } else if (code === 'expired_token') break;
    else if (code !== 'authorization_pending')
      throw unexpected(server, code ?? String(poll.response.status));
  }
  context.err('ROR-E114 The code expired before it was approved. Run `ror login` again.');
  return 11;
}
