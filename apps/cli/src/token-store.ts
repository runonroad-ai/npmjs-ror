/**
 * Where `ror` keeps the device token (ADR-0084 §2, SPEC-007 §4): the OS keychain, service
 * `runonroad`, account = the origin of the server that issued it. A token is only ever handed
 * back for that origin, and no store operation writes a file.
 *
 * `RUNONROAD_TOKEN` (SPEC-007 §3) takes precedence for agents: it is bound to the configured
 * server (`--server`, else `~/.runonroad/config.yaml`), which the caller passes in. It is never
 * bound to a URL read from a repository file, so a cloned repository cannot redirect it.
 */
import { Entry } from '@napi-rs/keyring';

import { RorError } from './ror-error.js';

export { RorError };

const SERVICE = 'runonroad';

/** The keychain, one entry per account under the `runonroad` service. Injected in tests. */
export interface KeychainBackend {
  get: (account: string) => string | undefined;
  set: (account: string, token: string) => void;
  delete: (account: string) => boolean;
}

// Pinned to Secret Service on Linux: the default falls back to the kernel keyring, which loses
// the token at reboot, and a missing keychain must fail instead (ADR-0084 §2).
const entry = (account: string) =>
  new Entry(SERVICE, account, { linux: { store: 'secret-service' } });

/** The OS keychain through `@napi-rs/keyring`: Keychain, Credential Manager, Secret Service. */
export const keyringBackend: KeychainBackend = {
  get: (account) => entry(account).getPassword() ?? undefined,
  set: (account, token) => {
    entry(account).setPassword(token);
  },
  delete: (account) => entry(account).deletePassword(),
};

/** The origin a token is bound to: scheme, host and port, a default port dropped. */
export function serverOrigin(server: string): string {
  const url = URL.parse(server);
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new RorError('ROR-E111', `Not a server URL: ${server}. Pass --server https://<host>.`);
  }
  return url.origin;
}

function keychain<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    throw new RorError(
      'ROR-E110',
      'The OS keychain is unavailable. On a machine without one, set RUNONROAD_TOKEN ' +
        'to an agent token instead of running `ror login`.',
      { cause },
    );
  }
}

export interface TokenStoreOptions {
  /** The configured server: `--server`, else `~/.runonroad/config.yaml`. */
  configuredServer: string;
  backend?: KeychainBackend;
  /** The process environment, passed in: only `packages/config` reads it (ADR-0037 §1). */
  env: Readonly<Record<string, string | undefined>>;
}

export interface TokenStore {
  /** The token for this server's origin, or `undefined`; never one another origin issued. */
  get: (server: string) => string | undefined;
  set: (server: string, token: string) => void;
  /** `true` when a token was removed. */
  delete: (server: string) => boolean;
}

export function tokenStore({
  configuredServer,
  backend = keyringBackend,
  env,
}: TokenStoreOptions): TokenStore {
  const agentToken = env.RUNONROAD_TOKEN === '' ? undefined : env.RUNONROAD_TOKEN;
  const agentOrigin = serverOrigin(configuredServer);
  return {
    get: (server) => {
      const origin = serverOrigin(server);
      if (agentToken !== undefined) return origin === agentOrigin ? agentToken : undefined;
      return keychain(() => backend.get(origin));
    },
    set: (server, token) => {
      const origin = serverOrigin(server);
      keychain(() => {
        backend.set(origin, token);
      });
    },
    delete: (server) => {
      const origin = serverOrigin(server);
      return keychain(() => backend.delete(origin));
    },
  };
}
