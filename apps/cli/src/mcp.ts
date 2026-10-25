/**
 * `ror mcp`: the stdio relay of the MCP server (ADR-0083 point 5, ticket #765). The tool starts it and talks JSON-RPC on
 * its standard input; each message goes to `/mcp` of the configured server with the token of that origin, and the answers
 * come out on the standard output, which carries nothing else. It adds no right.
 *
 * The token is `RUNONROAD_TOKEN` passed unchanged (an agent or personal token, ADR-0087: the relay never reads its
 * prefix and never enrols over it), or the device token of the keychain for the configured server's origin. With neither,
 * the first message runs the `ror login` enrolment (its words go to the standard error), then is forwarded. A `401` with
 * a stored token answers a JSON-RPC error that says to run `ror login`, without enrolling over it; an unreachable
 * server answers a JSON-RPC error that says so. No token is ever written to the output or the error stream.
 */
import { createInterface } from 'node:readline';

import { clientEnvironment } from '@runonroad/config/client';

import { apiClient } from './api.js';
import { flagValue } from './flags.js';
import { login, type LoginContext } from './login.js';
import { call } from './session.js';
import { readConfig } from './state.js';
import { RorError, tokenStore } from './token-store.js';

const NOT_SIGNED_IN = -32001;
const UNREACHABLE = -32002;

/** What a verb of `ror` has to read from: a stream of lines, the standard input by default. */
export interface McpContext extends LoginContext {
  readonly input?: NodeJS.ReadableStream;
}

type Message = { jsonrpc?: string; id?: unknown; method?: string };

const errorOf = (id: unknown, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** The messages an answer carries: one JSON body, or the `data:` events of a stream. */
function answersOf(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return [trimmed];
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((data) => data !== '');
}

export async function mcp(args: readonly string[], context: McpContext): Promise<number> {
  const server =
    flagValue(args, '--server') ?? readConfig(context.home).server ?? clientEnvironment().apiUrl;
  if (server === undefined) {
    throw new RorError(
      'ROR-E112',
      'No server configured. Run `ror login --server https://<host>` or pass --server.',
    );
  }
  const withEnvironmentToken =
    context.env['RUNONROAD_TOKEN'] !== undefined && context.env['RUNONROAD_TOKEN'] !== '';
  const tokens = tokenStore({
    configuredServer: server,
    env: context.env,
    ...(context.keychain && { backend: context.keychain }),
  });
  const client = apiClient({ server, tokens, ...(context.fetch && { fetch: context.fetch }) });
  const mount = server.replace(/\/+$/u, '');

  const lines = createInterface({ input: context.input ?? process.stdin });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      context.out(errorOf(null, -32700, 'The message is not JSON.'));
      continue;
    }
    // no token at all: the first message enrols the device (its words go to the error stream), then goes on
    let token = (() => {
      try {
        return tokens.get(server);
      } catch (error) {
        if (error instanceof RorError) return undefined;
        throw error;
      }
    })();
    if (token === undefined) {
      const quiet: LoginContext = { ...context, out: context.err };
      try {
        await login(['--server', server, '--non-interactive'], quiet);
      } catch (error) {
        if (!(error instanceof RorError)) throw error;
        context.err(error.message);
      }
      token = tokens.get(server);
      if (token === undefined) {
        context.out(errorOf(message.id, NOT_SIGNED_IN, 'Not signed in: run `ror login`.'));
        continue;
      }
    }
    let answered;
    try {
      answered = await call(client, 'POST', '/mcp', {
        baseUrl: mount,
        body: message,
        headers: { accept: 'application/json, text/event-stream' },
        timeoutMs: 60_000,
      });
    } catch {
      // the message of a network error can carry the address or the credential: only the kind leaves
      context.out(errorOf(message.id, UNREACHABLE, 'RunOnRoad is unreachable.'));
      continue;
    }
    if (answered.status === 401) {
      context.out(
        errorOf(
          message.id,
          NOT_SIGNED_IN,
          withEnvironmentToken
            ? 'RunOnRoad refused RUNONROAD_TOKEN: it is revoked, expired or unknown.'
            : 'RunOnRoad refused this device: run `ror login`.',
        ),
      );
      continue;
    }
    if (answered.status === 202 || answered.status === 204) continue;
    if (answered.status >= 500 || answered.status === 0) {
      context.out(errorOf(message.id, UNREACHABLE, 'RunOnRoad is unreachable.'));
      continue;
    }
    for (const answer of answersOf(answered.text)) context.out(answer);
  }
  return 0;
}
