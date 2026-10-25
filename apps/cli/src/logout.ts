// `ror logout [--server <url>]` (SPEC-007 §2): revoke this device on the server, then forget its
// token. The revocation is tried, never required: the keychain entry goes in every case.
import { apiClient } from './api.js';
import type { LoginContext } from './login.js';
import { readConfig, resolveServer } from './state.js';
import { RorError, serverOrigin, tokenStore, type TokenStore } from './token-store.js';

/** Why the server did not revoke the device, or `undefined` once it did. */
async function revoke(
  server: string,
  device: string | undefined,
  tokens: TokenStore,
  fetch: LoginContext['fetch'],
): Promise<string | undefined> {
  if (device === undefined) return 'this device id was not recorded at `ror login`';
  const client = apiClient({ server, tokens, ...(fetch && { fetch }) });
  try {
    const { response } = await client.DELETE('/devices/{id}', { params: { path: { id: device } } });
    return response.ok ? undefined : `${server} answered ${String(response.status)}`;
  } catch (error) {
    // ROR-E117: the server cannot be reached.
    if (error instanceof RorError) return error.message;
    throw error;
  }
}

/** Exit code 0 (SPEC-007 §2), whether or not the server could revoke the device. */
export async function logout(args: readonly string[], context: LoginContext): Promise<number> {
  const config = readConfig(context.home);
  const server = resolveServer(args, context.home);
  const origin = serverOrigin(server);
  // The keychain's device token only: an agent's RUNONROAD_TOKEN is no device of this machine.
  const { keychain: backend, fetch } = context;
  const tokens = tokenStore({ configuredServer: server, env: {}, ...(backend && { backend }) });
  if (tokens.get(server) === undefined) {
    context.out(`Nothing is signed in to ${origin}.`);
    return 0;
  }

  const sameServer = config.server !== undefined && serverOrigin(config.server) === origin;
  const device = sameServer ? config.device : undefined;
  const failure = await revoke(server, device, tokens, fetch);
  tokens.delete(server);
  if (failure === undefined) {
    context.out(`Device ${String(device)} revoked. Signed out of ${origin}.`);
  } else {
    context.err(
      `ROR-E118 The device could not be revoked on the server (${failure}). Signed out of ` +
        `${origin} on this machine: revoke the device from your profile in the console.`,
    );
  }
  return 0;
}
