/**
 * Attestation (ADR-0090): when code cannot decide a spot of what the AI is about to write (a
 * spelled-out number, a hypothesis, a quotation, a rule that depends on a condition it cannot
 * read), the AI of the conversation must say, for each spot, whether it really concerns the rule,
 * quoting the exact words. Code checks what it CAN check: that every spot is covered, that each
 * quote is in the content and overlaps the spot, that the answer belongs to this conversation and
 * this very change. It cannot check the judgment itself: a false "not applicable" remains possible,
 * and that is stated, not hidden. An attestation never lifts a violation code found by itself.
 *
 * Light on purpose (node built-ins and the matcher only): it runs inside the hook.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize, type Finding } from '@runonroad/content-rules';

import type { SimpleCommand } from './shell.js';
import { ensureStateDir, removeState, takeStateLock, writeStateFile } from './state.js';

export const ATTEST_TTL_MS = 30 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
const MAX_SPOTS = 50;
const MAX_ANSWERS = 6;
const WINDOW = 400;
const MAX_EVIDENCE = 300;

export interface Occurrence {
  readonly id: string;
  readonly rule_id: string;
  readonly mention: string;
  readonly seen: string;
}

interface Challenge {
  readonly id: string;
  readonly session: string;
  readonly turn: string | undefined;
  readonly digest: string;
  readonly occurrences: readonly Occurrence[];
  /** Per spot, the normalized words around it: where its quote must be found. Bounded, local, never sent. */
  readonly windows: Record<string, string>;
  readonly created: number;
  attempts: number;
  answers: number;
  state: 'pending' | 'attested' | 'rejected';
  reason: string;
}

const DIRECTORY = 'challenges';
const directory = (home: string): string => join(home, DIRECTORY);
const fileOf = (home: string, id: string): string => join(directory(home), `${id}.json`);
const relativeOf = (id: string): string => `${DIRECTORY}/${id}.json`;

function load(home: string, id: string): Challenge | undefined {
  try {
    return JSON.parse(readFileSync(fileOf(home, id), 'utf8')) as Challenge;
  } catch {
    return undefined;
  }
}

/** Written whole and renamed into place: two parallel hooks never see half a challenge. */
function save(home: string, challenge: Challenge): void {
  writeStateFile(home, relativeOf(challenge.id), JSON.stringify(challenge));
}

/** Reads, decides and writes one challenge with nobody else in between (a lock directory, briefly held). */
function withLock<T>(home: string, id: string, work: () => T): T {
  ensureStateDir(home, DIRECTORY);
  const lock = `${relativeOf(id)}.lock`;
  const deadline = Date.now() + 1500;
  while (!takeStateLock(home, lock)) {
    let stale = false;
    try {
      stale = Date.now() - statSync(`${fileOf(home, id)}.lock`).mtimeMs > 5000;
    } catch {
      // released meanwhile
    }
    if (stale) removeState(home, lock);
    else if (Date.now() > deadline) throw new Error('the question is busy');
  }
  try {
    return work();
  } finally {
    removeState(home, lock);
  }
}

function expire(home: string, now: number): void {
  try {
    for (const name of readdirSync(directory(home))) {
      const path = join(directory(home), name);
      if (name.endsWith('.lock')) continue;
      if (now - statSync(path).mtimeMs > ATTEST_TTL_MS * 2)
        removeState(home, `${DIRECTORY}/${name}`);
    }
  } catch {
    // no directory yet
  }
}

const digestOf = (texts: readonly string[], findings: readonly Finding[]): string =>
  createHash('sha256')
    .update(JSON.stringify([texts, findings.map((f) => [f.rule.id, f.mention, f.seen, f.rule])]))
    .digest('hex');

/** The command the AI is told to run; the hook recognises it and records the answer itself. */
export const attestCommand = (id: string): string =>
  `"${process.execPath}" "${fileURLToPath(new URL('./main.js', import.meta.url))}" attest --challenge ${id} --facts '<JSON>'`;

export type Settled =
  | { readonly state: 'attested' }
  | { readonly state: 'ask'; readonly message: string }
  | { readonly state: 'refused'; readonly message: string };

function instruction(challenge: Challenge): string {
  const spots = challenge.occurrences
    .map((o) => `${o.id}: rule ${o.rule_id}, about the words "${o.mention}", in "${o.seen}"`)
    .join(' | ');
  return (
    `RunOnRoad cannot decide ${String(challenge.occurrences.length)} spot(s) of what you are about to write and needs your judgment, with proof. ` +
    `For each spot say whether it REALLY concerns the rule ("violation") or not ("not_applicable"), and quote the exact words from the content that show it: the quote must be a continuous excerpt copied from the content that contains the words named for that spot. ` +
    `Run this command, with nothing else in it, replacing <JSON> by {"entries":[{"occurrence":"o1","verdict":"not_applicable","evidence":"words copied from the content"}]} ` +
    `(one entry per spot; verdict is violation or not_applicable): ${attestCommand(challenge.id)} . ` +
    `Then retry the same change unchanged. Spots: ${spots}. ` +
    `If a spot is a real violation, do not retry: correct the content and explain the rule to the person.`
  );
}

/**
 * The doubtful spots of one change (the candidate texts and their findings), settled against what
 * the AI attested in this conversation, or a request to attest.
 */
export function settle(
  home: string,
  session: { readonly id: string; readonly turn: string | undefined },
  texts: readonly string[],
  doubts: readonly Finding[],
  nowMs: number,
): Settled {
  expire(home, nowMs);
  if (doubts.length > MAX_SPOTS) {
    return {
      state: 'refused',
      message: `RunOnRoad found more than ${String(MAX_SPOTS)} doubtful spots in this change: split it, or correct the content so that less of it is doubtful.`,
    };
  }
  const digest = digestOf(texts, doubts);
  const key = createHash('sha256')
    .update(`${session.id}\u0000${digest}`)
    .digest('hex')
    .slice(0, 24);
  const refusal: Settled = {
    state: 'refused',
    message:
      'RunOnRoad could not settle these spots after several tries: correct the content so that nothing in it is doubtful, or tell the person what the rule asks.',
  };
  return withLock(home, key, (): Settled => {
    const existing = load(home, key);
    const alive =
      existing?.session === session.id &&
      existing.digest === digest &&
      nowMs - existing.created <= ATTEST_TTL_MS;
    if (existing !== undefined && alive) {
      if (existing.state === 'attested') return { state: 'attested' };
      existing.attempts += 1;
      if (existing.attempts > MAX_ATTEMPTS || existing.answers >= MAX_ANSWERS) {
        save(home, existing);
        return refusal;
      }
      const why =
        existing.state === 'rejected'
          ? `Your last answer was not accepted: ${existing.reason} `
          : '';
      existing.state = 'pending';
      save(home, existing);
      return { state: 'ask', message: `${why}${instruction(existing)}` };
    }
    const whole = texts.map(normalize).join('\n');
    const occurrences = doubts.map((f, index) => ({
      id: `o${String(index + 1)}`,
      rule_id: f.rule.id,
      mention: normalize(f.mention),
      seen: f.seen,
    }));
    // where each spot is: a bounded window of the normalized content around it, so a mention far into
    // a large file can still be quoted and no more of the content than needed is kept
    const windows: Record<string, string> = {};
    for (const occurrence of occurrences) {
      const at = whole.indexOf(normalize(occurrence.seen));
      const start = Math.max(0, (at < 0 ? whole.indexOf(occurrence.mention) : at) - WINDOW);
      windows[occurrence.id] = whole.slice(start, start + occurrence.seen.length + 2 * WINDOW);
    }
    const challenge: Challenge = {
      id: key,
      session: session.id,
      turn: session.turn,
      digest,
      occurrences,
      windows,
      created: nowMs,
      attempts: 1,
      answers: 0,
      state: 'pending',
      reason: '',
    };
    save(home, challenge);
    return { state: 'ask', message: instruction(challenge) };
  });
}

// ------------------------------------------------------------ the command

/** `ror attest --challenge ID --facts JSON`, alone: nothing chained, no redirection, nothing around it. */
export function parseAttest(
  simples: readonly SimpleCommand[] | undefined,
): { id: string; facts: string } | undefined {
  if (simples?.length !== 1) return undefined;
  const [only] = simples;
  if (only === undefined || only.redirects.length > 0) return undefined;
  const at = only.words.indexOf('attest');
  if (at < 1 || at > 2) return undefined;
  const rest = only.words.slice(at + 1);
  if (rest.length !== 4 || rest[0] !== '--challenge' || rest[2] !== '--facts') return undefined;
  const id = rest[1] ?? '';
  const facts = rest[3] ?? '';
  return /^[a-f0-9]{24}$/u.test(id) ? { id, facts } : undefined;
}

export interface Recorded {
  readonly ok: boolean;
  readonly message: string;
  /** A short reason code for the content-free audit: why an answer was not accepted. */
  readonly code?: string;
}

/** Checks an attestation against its challenge and remembers the result. The AI's words are data, never commands. */
export function record(
  home: string,
  session: { readonly id: string } | undefined,
  attest: { id: string; facts: string },
  nowMs: number = Date.now(),
): Recorded {
  try {
    return withLock(home, attest.id, () => recordLocked(home, session, attest, nowMs));
  } catch {
    // whatever goes wrong, the command is refused and nothing is accepted
    return {
      ok: false,
      message:
        'RunOnRoad could not record this answer: retry the change to get the question again.',
    };
  }
}

function recordLocked(
  home: string,
  session: { readonly id: string } | undefined,
  attest: { id: string; facts: string },
  nowMs: number,
): Recorded {
  const challenge = load(home, attest.id);
  if (
    challenge === undefined ||
    session === undefined ||
    challenge.session !== session.id ||
    nowMs - challenge.created > ATTEST_TTL_MS
  ) {
    return {
      ok: false,
      message:
        'RunOnRoad has no pending question for this conversation under that identifier: retry the change to get a new one.',
    };
  }
  // an accepted answer stays accepted and is never refreshed; a question that is out of tries stays closed
  if (challenge.state === 'attested') {
    return { ok: true, message: 'Attestation recorded. Retry the original change, unchanged.' };
  }
  if (challenge.answers >= MAX_ANSWERS || challenge.attempts > MAX_ATTEMPTS) {
    return {
      ok: false,
      message: 'Not accepted: this question has used all its tries. Correct the content instead.',
    };
  }
  challenge.answers += 1;
  const reject = (reason: string, code: string): Recorded => {
    challenge.state = 'rejected';
    challenge.reason = reason;
    save(home, challenge);
    return {
      ok: false,
      message: `Not accepted: ${reason} Retry the change to get the question again.`,
      code,
    };
  };
  let entries: unknown;
  try {
    entries = (JSON.parse(attest.facts) as { entries?: unknown } | null)?.entries;
  } catch {
    return reject('the answer is not valid JSON.', 'not-json');
  }
  if (!Array.isArray(entries) || entries.length > 2 * MAX_SPOTS)
    return reject('"entries" must be a list.', 'entries');
  const byId = new Map<string, { verdict: unknown; evidence: unknown }>();
  for (const entry of entries as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return reject('every entry must be an object.', 'entry-shape');
    }
    const item = entry as Record<string, unknown>;
    if (typeof item['occurrence'] !== 'string')
      return reject('an entry has no "occurrence".', 'no-occurrence');
    byId.set(item['occurrence'], { verdict: item['verdict'], evidence: item['evidence'] });
  }
  for (const occurrence of challenge.occurrences) {
    const entry = byId.get(occurrence.id);
    if (entry === undefined) return reject(`spot ${occurrence.id} has no entry.`, 'missing-entry');
    if (entry.verdict === 'violation') {
      return reject(
        `you reported a violation at ${occurrence.id}: correct the content instead of writing it.`,
        'violation-reported',
      );
    }
    if (entry.verdict !== 'not_applicable') {
      return reject(
        `the verdict at ${occurrence.id} must be "violation" or "not_applicable".`,
        'verdict',
      );
    }
    const quote = typeof entry.evidence === 'string' ? normalize(entry.evidence).trim() : '';
    if (quote === '' || quote.length > MAX_EVIDENCE) {
      return reject(
        `the evidence at ${occurrence.id} is empty or longer than ${String(MAX_EVIDENCE)} characters.`,
        'evidence-size',
      );
    }
    if (!(challenge.windows[occurrence.id] ?? '').includes(quote)) {
      return reject(
        `the evidence at ${occurrence.id} is not words found in the content next to that spot.`,
        'evidence-not-found',
      );
    }
    // the quote must be about THIS spot: it contains the very value or term code found there
    if (!quote.includes(occurrence.mention)) {
      return reject(
        `the evidence at ${occurrence.id} is not about the spot ${occurrence.id}.`,
        'evidence-not-about-spot',
      );
    }
  }
  challenge.state = 'attested';
  challenge.reason = '';
  save(home, challenge);
  return { ok: true, message: 'Attestation recorded. Retry the original change, unchanged.' };
}
