/**
 * The one way `ror` reaches a server: the `@runonroad/api-contract` client (ADR-0014), never a
 * hand-written `fetch` and never RunOnRoadMCP's internal channel. `api.test.ts` fails when any
 * other module of `apps/cli` sends an HTTP request.
 *
 * The token is looked up for the origin of each request, not of the client, so a request sent
 * elsewhere (a per-call `baseUrl`) never carries a token that origin did not issue. A server the
 * token did not come from, such as one named by a repository file, gets no `Authorization`.
 *
 * A request that gets no answer at all (DNS, refused, TLS) becomes `ROR-E117`, never a stack trace.
 */
import { createClient } from '@runonroad/api-contract/client';

import { RorError, type TokenStore } from './token-store.js';

export interface ApiClientOptions {
  /** The server to call: the configured one, or the one `ror login` was pointed at. */
  server: string;
  tokens: TokenStore;
  fetch?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createClient>;

export function apiClient({ server, tokens, fetch }: ApiClientOptions): ApiClient {
  const client = createClient({ apiUrl: server, ...(fetch === undefined ? {} : { fetch }) });
  client.use({
    onRequest({ request }) {
      const token = tokens.get(request.url);
      if (token !== undefined) request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
    onError({ error }) {
      const reason =
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : String(error);
      return new RorError(
        'ROR-E117',
        `${server} cannot be reached (${reason}). Check --server and the network, then retry.`,
        { cause: error },
      );
    },
  });
  return client;
}
