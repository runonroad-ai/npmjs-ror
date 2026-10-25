/**
 * What a verb that talks to the server needs, assembled once from what `ror login` left on the
 * machine (SPEC-007 §2): where the server is (`config.yaml`), the device token (the OS keychain),
 * the organization and the keys every bundle is verified with (`signing-keys.json`). The token is
 * held in memory for one run and never written anywhere.
 */
import type { SigningKey } from '@runonroad/api-contract';

import { apiClient, type ApiClient } from './api.js';
import type { LoginContext } from './login.js';
import { readConfig, readPinnedKeys } from './state.js';
import { tokenStore } from './token-store.js';

export interface Enrolment {
  readonly api: string;
  readonly device_token: string;
  readonly organization_id: string;
  readonly keys: readonly SigningKey[];
}

/** The pinned keys of an enrolment, as `verifyBody` takes them. */
export const pinnedKeys = (enrolment: Enrolment): readonly SigningKey[] => enrolment.keys;

/** The enrolment of this machine, or `undefined` when `ror login` has never run (or its token is gone). */
export function loadEnrolment(context: LoginContext, server?: string): Enrolment | undefined {
  const api = server ?? readConfig(context.home).server;
  if (api === undefined) return undefined;
  const tokens = tokenStore({
    configuredServer: api,
    env: context.env,
    ...(context.keychain && { backend: context.keychain }),
  });
  const token = tokens.get(api);
  const pinned = readPinnedKeys(context.home);
  if (token === undefined || pinned === undefined) return undefined;
  return { api, device_token: token, organization_id: pinned.organization_id, keys: pinned.keys };
}

/** The contract client of one enrolment: the token goes to the origin it was issued for, and no other. */
export function clientOf(enrolment: Enrolment, fetchImpl?: typeof fetch): ApiClient {
  return apiClient({
    server: enrolment.api,
    tokens: {
      get: (server) =>
        new URL(server).origin === new URL(enrolment.api).origin
          ? enrolment.device_token
          : undefined,
      set: () => undefined,
      delete: () => false,
    },
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

/** A response read as text: what the signature of a bundle or a skill is checked on. */
export interface Answered {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

/**
 * One call of the contract client whose path is built at run time (an id in it), read as text
 * (a signature is checked on the exact bytes). Still the generated client, so `api.test.ts` holds.
 */
export async function call(
  client: ApiClient,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: {
    readonly body?: unknown;
    readonly query?: Record<string, string | number>;
    readonly headers?: Record<string, string>;
    readonly timeoutMs?: number;
    /** Another mount point than `<server>/v1`: `/mcp` is served at the root of the API origin (ADR-0083). */
    readonly baseUrl?: string;
  } = {},
): Promise<Answered> {
  const { response, data, error } = await (
    client as unknown as {
      request: (
        method: string,
        path: string,
        init: Record<string, unknown>,
      ) => Promise<{ response: Response; data?: unknown; error?: unknown }>;
    }
  ).request(method, path, {
    parseAs: 'text',
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.query === undefined ? {} : { params: { query: options.query } }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const text = typeof data === 'string' ? data : typeof error === 'string' ? error : '';
  return { status: response.status, headers: response.headers, text };
}
