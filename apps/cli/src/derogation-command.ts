/**
 * `ror derogation request <rule> --reason <why> [--dry-run] | list [--status <s>] | show <id> |
 * answer <id> --text <precision>` (ADR-0116): the device token of `ror login` asks and follows, and
 * never decides. The calls are in `derogation.ts`; this module is the verb.
 */
import type { DerogationStatus } from '@runonroad/api-contract';

import { apiClient } from './api.js';
import {
  answerDerogation,
  listDerogations,
  previewDerogation,
  requestDerogation,
  showDerogation,
} from './derogation.js';
import { flagValue } from './flags.js';
import type { LoginContext } from './login.js';
import { readConfig } from './state.js';
import { RorError, tokenStore } from './token-store.js';

/** The states of a derogation, as the contract names them (a type check keeps the list whole). */
const STATUSES = [
  'requested',
  'clarification',
  'granted',
  'denied',
  'revoked',
] as const satisfies readonly DerogationStatus[];
const isStatus = (value: string): value is DerogationStatus =>
  (STATUSES as readonly string[]).includes(value);

const WITH_VALUE = new Set(['--reason', '--status', '--text', '--server']);
const USAGE =
  'usage: ror derogation request <rule-id> --reason <why> [--dry-run] | list [--status <s>] | show <id> | answer <id> --text <precision>';

/** The words that are neither a flag nor a flag's value. */
function positional(args: readonly string[]): string[] {
  const words: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const token = args[at] ?? '';
    if (WITH_VALUE.has(token)) at += 1;
    else if (!token.startsWith('-')) words.push(token);
  }
  return words;
}

export async function derogation(args: readonly string[], context: LoginContext): Promise<number> {
  const [verb, subject] = positional(args);
  const reason = flagValue(args, '--reason');
  const text = flagValue(args, '--text');
  const status = flagValue(args, '--status');
  if (status !== undefined && !isStatus(status)) {
    context.err(`ROR-E001 --status takes one of: ${STATUSES.join(', ')}.`);
    return 1;
  }
  if (
    verb === 'request' &&
    subject !== undefined &&
    reason !== undefined &&
    args.includes('--dry-run')
  ) {
    for (const line of previewDerogation(subject, reason)) context.out(line);
    return 0;
  }
  const server = flagValue(args, '--server') ?? readConfig(context.home).server;
  if (server === undefined) {
    throw new RorError(
      'ROR-E112',
      'No server configured. Run `ror login --server https://<host>`.',
    );
  }
  const tokens = tokenStore({
    configuredServer: server,
    env: context.env,
    ...(context.keychain && { backend: context.keychain }),
  });
  if (tokens.get(server) === undefined) {
    context.err('ROR-E401: not logged in; run `ror login`');
    return 11;
  }
  const env = {
    client: apiClient({ server, tokens, ...(context.fetch && { fetch: context.fetch }) }),
  };
  const say = (ok: boolean, lines: readonly string[]): number => {
    for (const line of lines) (ok ? context.out : context.err)(line);
    return ok ? 0 : 31;
  };
  if (verb === 'request' && subject !== undefined && reason !== undefined) {
    const result = await requestDerogation(env, subject, reason);
    return say(result.ok, [result.message]);
  }
  if (verb === 'list') {
    const result = await listDerogations(env, status);
    return say(result.ok, result.lines);
  }
  if (verb === 'show' && subject !== undefined) {
    const result = await showDerogation(env, subject);
    return say(result.ok, result.lines);
  }
  if (verb === 'answer' && subject !== undefined && text !== undefined) {
    const result = await answerDerogation(env, subject, text);
    return say(result.ok, [result.message]);
  }
  context.err(USAGE);
  return 31;
}
