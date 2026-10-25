/**
 * `ror derogation`: ask for the lift of an Ask-first rule, and see where the
 * requests stand (ADR-0116). Deciding is not here, on purpose: a device — and so
 * the agent running on it — can ask, never approve. Owners and admins decide
 * from the console, where a person is signed in. Every call goes through the generated client (ADR-0014).
 */
import type { Derogation, DerogationStatus } from '@runonroad/api-contract';

import type { ApiClient } from './api.js';
import { RorError } from './token-store.js';

export interface DerogationEnv {
  readonly client: ApiClient;
}

/** Text another person wrote, as one printable line: a control character never reaches the terminal. */
// eslint-disable-next-line no-control-regex -- the control characters are what is removed
const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ');

/** A call that cannot hang the command: the network answers within the delay or the command says so. */
const DELAY_MS = 15_000;
const within = (): { signal: AbortSignal } => ({ signal: AbortSignal.timeout(DELAY_MS) });

/** What the server said about a refusal, as one printable line. */
function problem(status: number, error: unknown): string {
  const body = (typeof error === 'object' && error !== null ? error : {}) as {
    detail?: unknown;
    code?: unknown;
    reason?: unknown;
  };
  const code = typeof body.code === 'string' ? body.code : String(status);
  const reason = typeof body.reason === 'string' ? ` (${body.reason})` : '';
  const detail = typeof body.detail === 'string' ? `: ${body.detail}` : '';
  return printable(`${code}${reason}${detail}`);
}

/** A 200 that is not JSON: the server answered, but not what the contract says. */
const unexpected = { ok: false, message: 'the server answered something unexpected' } as const;

/** What a request would say, before anything leaves the device (mock-up S005). */
export const previewDerogation = (ruleId: string, reason: string): string[] => [
  'request preview, not sent yet',
  `rule     ${ruleId}`,
  `reason   ${reason}`,
  'effect   an owner or admin decides it in the console; nothing changes until the lease is granted and `ror sync` brings it',
  'send it by running the same command without --dry-run',
];

export async function requestDerogation(
  env: DerogationEnv,
  ruleId: string,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const { data, error, response } = await env.client.POST('/derogations', {
      body: { rule_id: ruleId, reason },
      ...within(),
    });
    if (response.status === 401) return { ok: false, message: 'ROR-E401: run `ror login`' };
    if (data === undefined)
      return { ok: false, message: `refused: ${problem(response.status, error)}` };
    return {
      ok: true,
      message: `requested ${data.id} for ${data.ruleId}; an owner or admin decides it in the console, then \`ror sync\` brings the lease`,
    };
  } catch (error) {
    if (!(error instanceof RorError)) return unexpected;
    return { ok: false, message: 'the server is unreachable: a request needs the network' };
  }
}

const lineOf = (item: Derogation): string =>
  `${item.id} ${item.status.padEnd(13)} ${item.ruleId}${item.expiresAt === null ? '' : ` until ${item.expiresAt}`}`;

export async function listDerogations(
  env: DerogationEnv,
  status?: DerogationStatus,
): Promise<{ ok: boolean; lines: string[] }> {
  try {
    const { data, error, response } = await env.client.GET('/derogations', {
      params: { query: { mine: 'true', ...(status === undefined ? {} : { status }) } },
      ...within(),
    });
    if (data === undefined) {
      return { ok: false, lines: [`refused: ${problem(response.status, error)}`] };
    }
    return { ok: true, lines: data.items.map(lineOf) };
  } catch (error) {
    if (!(error instanceof RorError)) return { ok: false, lines: [unexpected.message] };
    return { ok: false, lines: ['the server is unreachable'] };
  }
}

/** One request in full: what the approver said (a question, a refusal) and what was answered. */
export async function showDerogation(
  env: DerogationEnv,
  id: string,
): Promise<{ ok: boolean; lines: string[] }> {
  try {
    const { data, error, response } = await env.client.GET('/derogations/{id}', {
      params: { path: { id } },
      ...within(),
    });
    if (data === undefined) {
      return { ok: false, lines: [`refused: ${problem(response.status, error)}`] };
    }
    return {
      ok: true,
      lines: [
        lineOf(data),
        `reason   ${printable(data.reason)}`,
        ...(data.note === null ? [] : [`approver ${printable(data.note)}`]),
        ...(data.answer === null ? [] : [`answer   ${printable(data.answer)}`]),
        ...(data.status === 'clarification'
          ? [`answer it with: ror derogation answer ${data.id} --text "<precision>"`]
          : []),
        ...(data.status === 'granted' ? ['run `ror sync` to bring the lease to this device'] : []),
      ],
    };
  } catch (error) {
    if (!(error instanceof RorError)) return { ok: false, lines: [unexpected.message] };
    return { ok: false, lines: ['the server is unreachable'] };
  }
}

/** The precision an approver asked for (the request stays pending until they decide). */
export async function answerDerogation(
  env: DerogationEnv,
  id: string,
  text: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const { data, error, response } = await env.client.POST('/derogations/{id}/answer', {
      params: { path: { id } },
      body: { answer: text },
      ...within(),
    });
    if (response.status === 401) return { ok: false, message: 'ROR-E401: run `ror login`' };
    if (data === undefined)
      return { ok: false, message: `refused: ${problem(response.status, error)}` };
    return { ok: true, message: `answered ${id}; the approver decides it in the console` };
  } catch (error) {
    if (!(error instanceof RorError)) return unexpected;
    return { ok: false, message: 'the server is unreachable: an answer needs the network' };
  }
}
