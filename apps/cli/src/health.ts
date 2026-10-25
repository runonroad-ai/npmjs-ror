/**
 * What the hook writes about its own failures (ADR-0091): technical incidents only, on the device,
 * from a closed vocabulary. No text, no path, no rule id, no call volume (ADR-0012). Nothing here
 * touches the network, takes a lock or waits: a write that cannot be done at once is lost, and the
 * hook's answer never depends on it (ADR-0008).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  appendBoundedLines,
  appendLineGuarded,
  readSafe as readSafeFile,
  removeState,
  renameState,
  replaceStateFile,
} from './state.js';

export const HEALTH_CODES = [
  'invalid_input',
  'cache_unreadable',
  'policy_missing',
  'policy_expired',
  'signature_invalid',
  'version_incompatible',
  'internal_error',
] as const;
export type HealthCode = (typeof HEALTH_CODES)[number];

export const HEALTH_EFFECTS = ['failed_open', 'failed_closed', 'none'] as const;
export type HealthEffect = (typeof HEALTH_EFFECTS)[number];

export const HEALTH_HOOKS = ['pre_tool_use', 'user_prompt_submit', 'stop'] as const;
export type HealthHook = (typeof HEALTH_HOOKS)[number];

export interface Incident {
  readonly target: 'claude_code' | 'codex' | 'cursor';
  readonly hook: HealthHook;
  readonly code: HealthCode;
  readonly effect: HealthEffect;
}

const LOG = 'ror-health.log';
const MARKER = '!incomplete\n';
const longest = (words: readonly string[]): number => Math.max(...words.map((word) => word.length));
/** The longest valid line: four words, three spaces and a newline. */
const LONGEST_LINE =
  longest(['claude_code', 'codex', 'cursor']) +
  longest(HEALTH_HOOKS) +
  longest(HEALTH_CODES) +
  longest(HEALTH_EFFECTS) +
  4;
const TAKEN = 'ror-health.log.taking';
const STATE = 'ror-health.json';
/** Four files at most (live log, taken log, state, its temporary copy), 16 KiB each: 64 KiB in all. */
const MAX_BYTES = 16 * 1024;
const MAX_INCIDENTS = 128;
const GENERATION = /^[A-Za-z0-9_-]{8,64}$/u;

/**
 * Reads a health file the way the hook writes it: through a descriptor opened without following a link
 * and without waiting (a pipe planted at its place is refused, never blocked on), only if it is a regular
 * file, and no more than `limit` bytes. `size` is the whole file's size, which may exceed what was read.
 */
function readSafe(path: string, limit = MAX_BYTES): { text: Buffer; size: number } | undefined {
  return readSafeFile(path, limit);
}

/** What `ror sync` sends: closed incidents, never a count (ADR-0091). Immutable once captured. */
export interface Batch {
  readonly generation: string;
  readonly sequence: number;
  readonly incidents: Incident[];
  readonly incomplete: boolean;
  readonly saturated: boolean;
}

/** The part only `ror sync` writes (under the machine lock): the stream and the batch not yet acknowledged. */
interface State {
  stream?: { generation: string; next: number };
  pending?: Batch;
  /** Do not try again before `notBefore` (ms): jittered exponential backoff, capped at one hour. */
  retry?: { notBefore: number; failures: number };
}

/** The known policy refusals as closed codes: the free-text reason never leaves `loadPolicy`. */
export function codeOfPolicyRefusal(why: string): HealthCode {
  if (why === 'no policy file' || why === 'this device is not enrolled') return 'policy_missing';
  if (why === 'the policy has expired') return 'policy_expired';
  if (why === 'the policy file is malformed') return 'cache_unreadable';
  if (
    why === 'the policy holds a rule this ror does not understand' ||
    why === 'the policy holds a derogation this ror does not understand'
  ) {
    return 'version_incompatible';
  }
  if (
    why === 'the policy is older than the one applied' ||
    why === 'the policy is not for this organization' ||
    why === 'the policy is for another person' ||
    why === 'the bundle carries no policy' ||
    why === 'the policy has no valid issue date'
  ) {
    return 'invalid_input';
  }
  // a signature that does not verify, or anything unforeseen
  return why.length > 0 ? 'signature_invalid' : 'internal_error';
}

const TARGETS = ['claude_code', 'codex', 'cursor'];

const isIncident = (value: unknown): value is Incident => {
  const entry = value as Partial<Incident> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    TARGETS.includes(entry.target ?? '') &&
    (HEALTH_HOOKS as readonly string[]).includes(entry.hook ?? '') &&
    (HEALTH_CODES as readonly string[]).includes(entry.code ?? '') &&
    (HEALTH_EFFECTS as readonly string[]).includes(entry.effect ?? '')
  );
};

function validBatch(value: unknown): Batch | undefined {
  const batch = value as Partial<Batch> | null;
  if (
    typeof batch !== 'object' ||
    batch === null ||
    typeof batch.generation !== 'string' ||
    !GENERATION.test(batch.generation) ||
    !Number.isInteger(batch.sequence) ||
    !Array.isArray(batch.incidents) ||
    batch.incidents.length > MAX_INCIDENTS ||
    !batch.incidents.every(isIncident)
  ) {
    return undefined;
  }
  return {
    generation: batch.generation,
    sequence: batch.sequence as number,
    incidents: batch.incidents.map(({ target, hook, code, effect }) => ({
      target,
      hook,
      code,
      effect,
    })),
    incomplete: batch.incomplete === true,
    saturated: batch.saturated === true,
  };
}

function readState(home: string): State {
  try {
    const read = readSafe(join(home, STATE));
    if (read === undefined || read.size > MAX_BYTES) return {};
    const raw = read.text.toString('utf8');
    const parsed = JSON.parse(raw) as {
      stream?: { generation?: unknown; next?: unknown };
      pending?: unknown;
      retry?: { notBefore?: unknown; failures?: unknown };
    };
    const stream = parsed.stream;
    const pending = validBatch(parsed.pending);
    return {
      ...(typeof stream?.generation === 'string' &&
      GENERATION.test(stream.generation) &&
      Number.isInteger(stream.next) &&
      (stream.next as number) >= 1
        ? { stream: { generation: stream.generation, next: stream.next as number } }
        : {}),
      ...(pending === undefined ? {} : { pending }),
      ...(Number.isFinite(parsed.retry?.notBefore) && Number.isInteger(parsed.retry?.failures)
        ? {
            retry: {
              notBefore: parsed.retry?.notBefore as number,
              failures: parsed.retry?.failures as number,
            },
          }
        : {}),
    };
  } catch {
    return {};
  }
}

function writeState(home: string, state: State): void {
  replaceStateFile(home, STATE, JSON.stringify(state));
}

/**
 * Notes one incident, from the hook. It only ever APPENDS one short line to a private file opened
 * without following a link: no read, no rewrite, no lock, so two hooks and a sync never undo one
 * another. A full file drops the observation (the sync then reports it as incomplete). Any failure
 * is a lost observation, never an error for the hook (ADR-0008).
 */
export function recordIncident(home: string, incident: Incident): void {
  const line = `${incident.target} ${incident.hook} ${incident.code} ${incident.effect}\n`;
  // the whole line must fit; concurrent writers may overshoot by a line or two, never more
  appendLineGuarded(home, LOG, line, MAX_BYTES - MARKER.length);
}

/**
 * Reads the lines noted since the last capture. The file is KEPT (as `.taking`) until the pending
 * batch is committed: a crash in between loses nothing, the next capture reads it again.
 */
function takeLog(home: string): {
  incidents: Incident[];
  incomplete: boolean;
  saturated: boolean;
  bytes: number;
} {
  let bytes = 0;
  const found = new Map<string, Incident>();
  let incomplete = false;
  let saturated = false;
  const live = join(home, LOG);
  const taken = join(home, TAKEN);
  // an empty generation (a hook created the file and left) is retired, or capture would stall on it
  const peek = readSafe(taken);
  if (peek !== undefined && peek.size === 0) removeState(home, TAKEN);
  // anything at that name that is not a regular file is removed, never read
  else if (existsSync(taken) && peek === undefined) removeState(home, TAKEN);
  if (!existsSync(taken) && existsSync(live)) renameState(home, LOG, TAKEN);
  const reading = readSafe(taken);
  if (reading !== undefined) {
    bytes = reading.size;
    if (bytes >= MAX_BYTES - MARKER.length - LONGEST_LINE) saturated = true;
    const text = reading.text.toString('utf8');
    for (const line of text.split('\n')) {
      if (line === '') continue;
      if (line === '!incomplete') {
        incomplete = true;
        continue;
      }
      const [target, hook, code, effect, extra] = line.split(' ');
      const incident = { target, hook, code, effect };
      if (extra !== undefined || !isIncident(incident)) {
        incomplete = true;
        continue;
      }
      const key = `${incident.target}|${incident.hook}|${incident.code}|${incident.effect}`;
      if (found.size >= MAX_INCIDENTS && !found.has(key)) incomplete = true;
      else found.set(key, incident);
    }
  }
  return { incidents: [...found.values()], incomplete, saturated, bytes };
}

/**
 * The batch `ror sync` sends now: the one captured earlier and never acknowledged, else a new one made
 * of the incidents noted since (the exact repetitions stay on the device and are never sent). Nothing
 * to say, nothing to send. Called under the machine lock, so one sync at a time owns the state.
 */
/**
 * Retires the taken file once its lines are in the committed batch. Lines a hook appended AFTER we read
 * it (it still held the moved file) go back to the live log, to be captured next time.
 */
function retire(home: string, readBytes: number): void {
  const path = join(home, TAKEN);
  try {
    const all = readSafe(path);
    const late = all === undefined ? Buffer.alloc(0) : all.text.subarray(readBytes);
    if (late.length > 0) appendBounded(home, late.toString('utf8'));
    removeState(home, TAKEN);
  } catch {
    // already gone: nothing to return
  }
}

/**
 * Appends lines to the live log through a descriptor opened without following a link, within the same
 * bound as the hook. What does not fit is lost and replaced by an `!incomplete` marker (never read as a
 * recovery), so a repeated crash cannot grow the file.
 */
function appendBounded(home: string, text: string): void {
  appendBoundedLines(
    home,
    LOG,
    text.split('\n').filter((line) => line !== ''),
    MAX_BYTES,
    MARKER,
  );
}

/** The lines of the taken file whose incident is not in `pending` return to the live log; then it goes. */
function requeueUnseen(home: string, pending: Batch): void {
  const path = join(home, TAKEN);
  try {
    const known = new Set(
      pending.incidents.map((each) => `${each.target} ${each.hook} ${each.code} ${each.effect}`),
    );
    const unseen = (readSafe(path)?.text.toString('utf8') ?? '')
      .split('\n')
      .filter((line) => line !== '' && !known.has(line));
    if (unseen.length > 0) appendBounded(home, unseen.join('\n'));
    removeState(home, TAKEN);
  } catch {
    // already gone
  }
}

export function captureBatch(home: string, newGeneration: () => string): Batch | undefined {
  try {
    const state = readState(home);
    if (state.pending !== undefined) {
      // a capture that committed but did not finish cleaning up: what its file holds is in the batch,
      // except a line a late hook added, which goes back to the live log
      requeueUnseen(home, state.pending);
      return state.pending;
    }
    const taken = takeLog(home);
    if (taken.incidents.length === 0 && !taken.incomplete && !taken.saturated) return undefined;
    const stream = state.stream ?? { generation: newGeneration(), next: 1 };
    const batch: Batch = {
      generation: stream.generation,
      sequence: stream.next,
      incidents: taken.incidents,
      incomplete: taken.incomplete,
      saturated: taken.saturated,
    };
    writeState(home, {
      stream: { generation: stream.generation, next: Math.min(stream.next + 1, 2147483647) },
      pending: batch,
    });
    retire(home, taken.bytes);
    return batch;
  } catch {
    return undefined;
  }
}

/** The server acknowledged (or permanently refused) this very batch: it is not sent again. */
export function settleBatch(home: string, batch: Batch): void {
  try {
    const state = readState(home);
    if (
      state.pending?.sequence !== batch.sequence ||
      state.pending.generation !== batch.generation
    ) {
      return;
    }
    delete state.pending;
    delete state.retry;
    writeState(home, state);
  } catch {
    // the batch stays pending and is sent again, which the server tolerates
  }
}

/** What a test or a diagnostic can read of the pending state. */
export const pendingBatch = (home: string): Batch | undefined => readState(home).pending;

const HOUR_MS = 3_600_000;

/** Whether a send may be tried now (ms clock): a failed one waits, with jitter, up to an hour. */
export function mayTry(home: string, nowMs: number): boolean {
  const retry = readState(home).retry;
  return retry === undefined || nowMs >= retry.notBefore;
}

/** A send failed for a reason that may pass (429, 5xx, no network): wait, honouring Retry-After. */
export function noteFailure(
  home: string,
  nowMs: number,
  attempted: Batch,
  retryAfterSeconds?: number,
): void {
  try {
    const state = readState(home);
    // only for the batch that was tried: a newer state is never overwritten
    if (
      state.pending?.sequence !== attempted.sequence ||
      state.pending.generation !== attempted.generation
    ) {
      return;
    }
    const failures = Math.min((state.retry?.failures ?? 0) + 1, 20);
    const backoff = Math.min(60_000 * 2 ** (failures - 1), HOUR_MS);
    const jittered = backoff / 2 + Math.random() * (backoff / 2);
    const asked = retryAfterSeconds === undefined ? 0 : Math.min(retryAfterSeconds * 1000, HOUR_MS);
    state.retry = { notBefore: nowMs + Math.max(jittered, asked), failures };
    writeState(home, state);
  } catch {
    // no backoff recorded: the next sync tries again, which the server limits
  }
}
