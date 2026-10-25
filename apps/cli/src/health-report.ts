/**
 * The upload of the hook's health by `ror sync` (ADR-0091): off the hook's critical path, after the
 * bundle was fetched and before the machine lock is taken. Best effort and bounded: whatever happens
 * here, the outcome of the sync is the bundle's. A batch stays pending until the server answers.
 */
import { randomBytes } from 'node:crypto';

import type { ApiClient } from './api.js';
import { captureBatch, mayTry, noteFailure, settleBatch } from './health.js';
import { withMachineLock } from './state.js';

const TIMEOUT_MS = 5000;

export async function reportHealth(
  env: { readonly client: ApiClient; readonly now?: () => Date },
  home: string,
): Promise<void> {
  const nowMs = (env.now?.() ?? new Date()).getTime();
  if (!mayTry(home, nowMs)) return;
  // the state belongs to one sync at a time; the network call below is made outside the lock
  let batch: ReturnType<typeof captureBatch>;
  try {
    batch = withMachineLock(() => captureBatch(home, () => randomBytes(12).toString('base64url')));
  } catch {
    return; // another writer holds the machine: next time
  }
  if (batch === undefined) return;
  const sent = batch;
  try {
    const { response } = await env.client.POST('/devices/health', {
      body: { ...batch, incidents: [...batch.incidents] },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // accepted, or refused for good (stale, malformed): either way it is not sent again
    if (response.status === 200 || response.status === 400 || response.status === 409) {
      withMachineLock(() => {
        settleBatch(home, sent);
      });
    } else {
      // 401, 403, 429, 5xx: the batch stays pending, and the next try waits (Retry-After first)
      const asked = Number(response.headers.get('retry-after'));
      withMachineLock(() => {
        noteFailure(home, nowMs, sent, Number.isFinite(asked) && asked > 0 ? asked : undefined);
      });
    }
  } catch {
    // offline or slow: the same batch goes out later, after a jittered wait
    try {
      withMachineLock(() => {
        noteFailure(home, nowMs, sent);
      });
    } catch {
      // the machine is busy: the next sync notes it
    }
  }
}
