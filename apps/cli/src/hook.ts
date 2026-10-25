/**
 * `ror hook` (ADR-0085, ADR-0008): Claude Code's PreToolUse hook. It reads the
 * signed policy that `ror sync` stored, verifies it again on every call, and
 * answers allow (silence) or deny. It makes no network call.
 *
 * Deliberately light on imports (no schema library): it starts on every tool
 * call, and its start-up time is the cost of every action the agent takes. Its
 * latency is measured by tools/ and reported, not assumed (ADR-0083).
 *
 * Fail closed: a policy that is missing, altered, for another organization or
 * person, older than the one applied, or expired leaves the agent able to read
 * and nothing else. A crash is a deny too.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { clientEnvironment } from '@runonroad/config/client';

import {
  evaluate,
  evaluateWithoutPolicy,
  type PolicyRule,
  type PolicyView,
  type ToolCall,
  type Verdict,
} from './evaluate.js';
import {
  blockReason,
  doubtSignal,
  injectionContext,
  liveContent,
  verdictOf,
} from './conversation.js';
import type { ContentRule, ContentScope } from '@runonroad/content-rules';
import {
  allowOutput,
  contextOutput,
  conversationInput,
  denyOutput,
  eventKind,
  parseRequest,
  promptBlockOutput,
  stopBlockOutput,
  type HookTarget,
} from './protocol.js';
import { parseAttest, record } from './attest.js';
import { parseShell } from './shell.js';
import { SignatureError, verifyBody } from './verify.js';
import { codeOfPolicyRefusal, recordIncident } from './health.js';
import { appendStateFile } from './state.js';

export type { HookTarget };
export const HOOK_TARGETS: readonly HookTarget[] = ['claude_code', 'codex', 'cursor'];

export const policyFileOf = (target: HookTarget): readonly string[] => [
  '.runonroad',
  'lock',
  `${target}.policy.json`,
];

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

/** A rule as the bundle carries it, or undefined when it is not one. */
export function readRule(value: unknown): PolicyRule | undefined {
  const rule = object(value);
  if (rule === undefined) return undefined;
  const { id, kind, decision, reason, required } = rule;
  if (
    typeof id !== 'string' ||
    typeof reason !== 'string' ||
    typeof required !== 'boolean' ||
    (decision !== 'forbid' && decision !== 'ask')
  ) {
    return undefined;
  }
  const common = { id, decision, reason, required } as const;
  if (kind === 'path') {
    const { access, glob } = rule;
    if (typeof glob !== 'string' || (access !== 'read' && access !== 'write' && access !== 'any')) {
      return undefined;
    }
    return { ...common, kind, access, glob };
  }
  if (kind === 'command') {
    const prefix = strings(rule['argv_prefix']);
    const flags = strings(rule['flags_any']);
    const { executable } = rule;
    if (typeof executable !== 'string' || prefix === undefined || flags === undefined) {
      return undefined;
    }
    return { ...common, kind, executable, argv_prefix: prefix, flags_any: flags };
  }
  return undefined;
}

/** The Ask-first rules lifted for this person, with the instant each lease ends; undefined when malformed. */
export function readDerogations(value: unknown): PolicyView['derogations'] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const lifted: { rule_id: string; expires_at_ms: number }[] = [];
  for (const entry of value) {
    const item = object(entry);
    const at = typeof item?.['expires_at'] === 'string' ? Date.parse(item['expires_at']) : NaN;
    if (typeof item?.['rule_id'] !== 'string' || Number.isNaN(at)) return undefined;
    lifted.push({ rule_id: item['rule_id'], expires_at_ms: at });
  }
  return lifted;
}

/** The part of a fiche a device uses: what to tell the AI. Anything malformed is simply not used. */
function readFiche(value: unknown): ContentRule['fiche'] {
  const fiche = object(value);
  const examples = object(fiche?.['examples']);
  const interpretation = fiche?.['interpretation'];
  if (typeof interpretation !== 'string' || examples === undefined) return undefined;
  const list = (key: string): string[] => strings(examples[key]) ?? [];
  return {
    interpretation,
    examples: {
      violation: list('violation'),
      compliant: list('compliant'),
      other_subject: list('other_subject'),
      ambiguous: list('ambiguous'),
    },
  };
}

const SCOPES: readonly ContentScope[] = ['prompt', 'file_write', 'answer'];

/** A content rule as the bundle carries it (strict: anything else is a policy this ror does not understand). */
export function readContentRule(value: unknown): ContentRule | undefined {
  const rule = object(value);
  if (rule === undefined || rule['kind'] !== 'content') return undefined;
  const { id, decision, reason, required, topic, text, constraint } = rule;
  const aliases = strings(rule['subject_aliases']);
  const alternatives = strings(rule['alternatives']) ?? [];
  const scopes = strings(rule['scopes']);
  const bound = object(constraint);
  if (
    typeof id !== 'string' ||
    typeof reason !== 'string' ||
    typeof required !== 'boolean' ||
    typeof topic !== 'string' ||
    typeof text !== 'string' ||
    (decision !== 'forbid' && decision !== 'ask') ||
    aliases === undefined ||
    scopes === undefined ||
    scopes.some((scope) => !SCOPES.includes(scope as ContentScope)) ||
    bound === undefined
  ) {
    return undefined;
  }
  const common = {
    id,
    kind: 'content',
    decision,
    reason,
    required,
    topic,
    text,
    subject_aliases: aliases,
    scopes: scopes as ContentScope[],
    mode: rule['mode'] === 'review' ? 'review' : 'block',
    alternatives,
    fiche: readFiche(rule['fiche']),
  } as const;
  if (bound['kind'] === 'number_bound') {
    const { operator, limit, unit, currency, binding_window: window } = bound;
    if (
      (operator !== 'lt' && operator !== 'lte' && operator !== 'gt' && operator !== 'gte') ||
      typeof limit !== 'string' ||
      !/^\d+(\.\d+)?$/u.test(limit) ||
      (unit !== 'percent' && unit !== 'amount' && unit !== 'count') ||
      typeof window !== 'number'
    ) {
      return undefined;
    }
    return {
      ...common,
      constraint: {
        kind: 'number_bound',
        operator,
        limit,
        unit,
        currency: typeof currency === 'string' ? currency : undefined,
        binding_window: window,
      },
    };
  }
  if (bound['kind'] === 'forbidden_terms') {
    const terms = strings(bound['terms']);
    const exceptions = strings(bound['context_exceptions']) ?? [];
    if (terms === undefined) return undefined;
    return {
      ...common,
      constraint: { kind: 'forbidden_terms', terms, context_exceptions: exceptions },
    };
  }
  return undefined;
}

/** Splits the bundle's rules into the ones the evaluator knows and the content rules; `unknown` counts the rest. */
export function readRules(values: readonly unknown[]): {
  rules: PolicyRule[];
  content: ContentRule[];
  unknown: number;
} {
  const rules: PolicyRule[] = [];
  const content: ContentRule[] = [];
  let unknown = 0;
  for (const value of values) {
    const kind = object(value)?.['kind'];
    const read = kind === 'content' ? readContentRule(value) : readRule(value);
    if (read === undefined) unknown += 1;
    else if (read.kind === 'content') content.push(read);
    else rules.push(read);
  }
  return { rules, content, unknown };
}

export type Loaded =
  { readonly ok: true; readonly policy: PolicyView } | { readonly ok: false; readonly why: string };

/** The state a hook may trust: pinned at enrolment and updated by `ror sync`. */
export interface TrustState {
  readonly keys: readonly {
    kty: 'OKP';
    crv: 'Ed25519';
    x: string;
    kid: string;
    use: 'sig';
    alg: 'EdDSA';
  }[];
  readonly organizationId: string;
  readonly lastSeenMs: number;
  readonly principal: string | undefined;
  readonly lockIssuedAt: string | undefined;
}

export function loadPolicy(
  projectDir: string,
  trust: TrustState,
  nowMs: number,
  target: HookTarget = 'claude_code',
): Loaded {
  const file = readJsonFile(join(projectDir, ...policyFileOf(target)));
  if (file === undefined) return { ok: false, why: 'no policy file' };
  const { body, signature } = file;
  if (typeof body !== 'string' || typeof signature !== 'string') {
    return { ok: false, why: 'the policy file is malformed' };
  }
  try {
    verifyBody(new TextEncoder().encode(body), signature, trust.keys);
  } catch (error) {
    return { ok: false, why: error instanceof SignatureError ? error.message : 'unverifiable' };
  }
  const bundle = object(JSON.parse(body));
  const policy = object(bundle?.['policy']);
  const rules = Array.isArray(policy?.['rules']) ? (policy['rules'] as unknown[]) : undefined;
  const mcp = strings(policy?.['mcp_allow']);
  if (bundle === undefined || policy === undefined || rules === undefined || mcp === undefined) {
    return { ok: false, why: 'the bundle carries no policy' };
  }
  if (bundle['organization_id'] !== trust.organizationId || bundle['target'] !== target) {
    return { ok: false, why: 'the policy is not for this organization' };
  }
  const principal = policy['principal'];
  if (trust.principal !== undefined && principal !== trust.principal) {
    return { ok: false, why: 'the policy is for another person' };
  }
  const issuedAt = typeof bundle['issued_at'] === 'string' ? Date.parse(bundle['issued_at']) : NaN;
  if (Number.isNaN(issuedAt)) return { ok: false, why: 'the policy has no valid issue date' };
  if (trust.lockIssuedAt !== undefined && !(issuedAt >= Date.parse(trust.lockIssuedAt))) {
    return { ok: false, why: 'the policy is older than the one applied' };
  }
  const expires = bundle['expires_at'];
  if (expires !== null && expires !== undefined) {
    const expiresAt = typeof expires === 'string' ? Date.parse(expires) : NaN;
    // an expiry that cannot be read is an expired policy, never an endless one
    if (Number.isNaN(expiresAt) || expiresAt <= nowMs) {
      return { ok: false, why: 'the policy has expired' };
    }
  }
  const parsed = readRules(rules);
  if (parsed.unknown > 0) {
    return { ok: false, why: 'the policy holds a rule this ror does not understand' };
  }
  const derogations = readDerogations(policy['derogations']);
  if (derogations === undefined) {
    return { ok: false, why: 'the policy holds a derogation this ror does not understand' };
  }
  return {
    ok: true,
    policy: { rules: parsed.rules, content: parsed.content, mcp_allow: mcp, derogations },
  };
}

/** Reads what `ror login` pinned (`signing-keys.json`) and the state, without a schema library. */
export function loadTrust(
  projectDir: string,
  home: string,
  target: HookTarget = 'claude_code',
): TrustState | undefined {
  const enrolment = readJsonFile(join(home, 'signing-keys.json'));
  const state = readJsonFile(join(home, 'state.json'));
  const keys = enrolment?.['keys'];
  const organizationId = enrolment?.['organization_id'];
  if (!Array.isArray(keys) || typeof organizationId !== 'string') return undefined;
  const principals = object(state?.['principals']);
  const principal = principals?.[projectDir];
  const lastSeen = state?.['last_seen_ms'];
  const lock = readJsonFile(join(projectDir, '.runonroad', 'lock', `${target}.json`));
  const issued = lock?.['issued_at'];
  return {
    keys: keys as TrustState['keys'],
    organizationId,
    lastSeenMs: typeof lastSeen === 'number' ? lastSeen : 0,
    principal: typeof principal === 'string' ? principal : undefined,
    lockIssuedAt: typeof issued === 'string' ? issued : undefined,
  };
}

function audit(home: string, call: ToolCall, verdict: Verdict, now: Date): void {
  try {
    // Content-free (ADR-0012): the tool and the rule, never the command or the path.
    appendStateFile(
      home,
      'audit.jsonl',
      `${JSON.stringify({
        at: now.toISOString(),
        tool: call.tool_name,
        decision: verdict.allow ? 'allow' : 'deny',
        rule: verdict.allow ? null : verdict.rule,
      })}\n`,
    );
  } catch {
    // an audit that cannot be written never turns a deny into an allow
  }
}

const physicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * The project, among those this device governs for `target`, that holds `cwd`: the deepest one,
 * compared by real path. Undefined when the session is in none of them.
 */
export function governedRoot(cwd: string, home: string, target: HookTarget): string | undefined {
  const registry = object(readJsonFile(join(home, 'state.json'))?.['targets']);
  const here = physicalPath(cwd);
  let best: string | undefined;
  for (const [project, tools] of Object.entries(registry ?? {})) {
    if (!Array.isArray(tools) || !tools.includes(target)) continue;
    const root = physicalPath(project);
    const inside = here === root || here.startsWith(root.endsWith(sep) ? root : root + sep);
    if (inside && (best === undefined || root.length > physicalPath(best).length)) best = project;
  }
  return best;
}

/** Content-free like the tool audit (ADR-0012): the moment, the rule and the decision, never the words. */
function auditConversation(home: string, event: string, rules: readonly string[], now: Date): void {
  try {
    for (const rule of new Set(rules)) {
      appendStateFile(
        home,
        'audit.jsonl',
        `${JSON.stringify({ at: now.toISOString(), tool: event, decision: 'deny', rule })}\n`,
      );
    }
  } catch {
    // an audit that cannot be written never turns a block into an allow
  }
}

/** Claude Code names the project in CLAUDE_PROJECT_DIR; without it, the nearest ancestor that has our state. */
function projectRootOf(cwd: string): string {
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.runonroad'))) return directory;
    if (dirname(directory) === directory) return cwd;
  }
}

export interface HookResult {
  /** What to print on stdout: empty for an allow on Claude Code and Codex. */
  readonly stdout: string;
  readonly exitCode: number;
}

export function runHook(
  stdin: string,
  now: Date = new Date(),
  target: HookTarget = 'claude_code',
  event?: string,
): HookResult {
  const environment = clientEnvironment();
  const home = environment.rorHome ?? join(environment.home ?? homedir(), '.runonroad');
  const refuse = (reason: string): HookResult => denyOutput(target, reason);
  const kind = eventKind(stdin, target, event);
  if (kind !== 'tool') return runConversation(kind, stdin, now, target, home);
  const call = parseRequest(stdin, target, event, environment.claudeProjectDir ?? '.');
  if (call === undefined)
    return refuse('RunOnRoad could not read this tool call, so it is refused');
  // Claude Code names its project. Codex and Cursor read hooks from the user's home, so the hook
  // asks the device's own registry which governed project the session is in: a marker folder an
  // agent could create below the project proves nothing (ADR-0086).
  let projectDir: string;
  if (target === 'claude_code') {
    projectDir = environment.claudeProjectDir ?? projectRootOf(call.cwd);
  } else {
    const governed = governedRoot(call.cwd, home, target);
    if (governed === undefined) return allowOutput(target);
    projectDir = governed;
  }
  const roots = { project: projectDir, home: environment.home ?? homedir(), ror: home };

  // the AI's answer to a question RunOnRoad asked (attest.ts): the hook records it itself, in the
  // state only it writes, and the command never runs
  if (call.tool_name === 'Bash' && typeof call.tool_input['command'] === 'string') {
    const attest = parseAttest(parseShell(call.tool_input['command'], call.cwd));
    if (attest !== undefined) {
      const recorded = record(home, call.session, attest, now.getTime());
      auditConversation(
        home,
        'Attest',
        [
          recorded.ok
            ? 'attestation-recorded'
            : `attestation-not-accepted:${recorded.code ?? 'other'}`,
        ],
        now,
      );
      return refuse(recorded.message);
    }
  }

  let verdict: Verdict;
  try {
    const trust = loadTrust(projectDir, home, target);
    const loaded =
      trust === undefined
        ? ({ ok: false, why: 'this device is not enrolled' } as const)
        : loadPolicy(projectDir, trust, Math.max(now.getTime(), trust.lastSeenMs), target);
    if (!loaded.ok) {
      recordIncident(home, {
        target,
        hook: 'pre_tool_use',
        code: codeOfPolicyRefusal(loaded.why),
        effect: 'none',
      });
    }
    verdict = loaded.ok
      ? evaluate(loaded.policy, call, roots, now.getTime())
      : evaluateWithoutPolicy(call, loaded.why, roots);
  } catch {
    recordIncident(home, {
      target,
      hook: 'pre_tool_use',
      code: 'internal_error',
      effect: 'failed_closed',
    });
    verdict = { allow: false, rule: null, reason: 'RunOnRoad failed while checking this call' };
  }
  audit(home, call, verdict, now);
  if (verdict.allow) return allowOutput(target, verdict.signal);
  const who = verdict.rule === null ? 'RunOnRoad' : `RunOnRoad rule ${verdict.rule}`;
  return refuse(`Blocked by ${who}: ${verdict.reason}`);
}

/**
 * The prompt and the end of an answer (ADR-0088). The prompt is stopped only on an explicit
 * violation; otherwise the AI gets the rules and anything doubtful. At the end of an answer a
 * violation sends the AI back to correct itself, once. A policy that cannot be read leaves the
 * conversation alone: the tools are held read-only by the tool hook in that case.
 */
function runConversation(
  kind: 'prompt' | 'stop',
  stdin: string,
  now: Date,
  target: HookTarget,
  home: string,
): HookResult {
  const environment = clientEnvironment();
  const input = conversationInput(stdin, environment.claudeProjectDir ?? '.');
  const nothing = kind === 'prompt' ? contextOutput(target, '') : { stdout: '', exitCode: 0 };
  if (input === undefined) return nothing;
  const projectDir =
    target === 'claude_code'
      ? (environment.claudeProjectDir ?? projectRootOf(input.cwd))
      : governedRoot(input.cwd, home, target);
  if (projectDir === undefined) return nothing;
  try {
    const trust = loadTrust(projectDir, home, target);
    if (trust === undefined) return nothing;
    const loaded = loadPolicy(projectDir, trust, Math.max(now.getTime(), trust.lastSeenMs), target);
    if (!loaded.ok) {
      recordIncident(home, {
        target,
        hook: kind === 'prompt' ? 'user_prompt_submit' : 'stop',
        code: codeOfPolicyRefusal(loaded.why),
        effect: 'failed_open',
      });
      return nothing;
    }
    const rules = liveContent(
      loaded.policy.content ?? [],
      loaded.policy.derogations ?? [],
      now.getTime(),
    );
    if (rules.length === 0) return nothing;
    if (kind === 'prompt') {
      const verdict = verdictOf(rules, 'prompt', input.prompt ?? '');
      if (verdict.violations.length > 0) {
        auditConversation(
          home,
          'UserPromptSubmit',
          verdict.violations.map((v) => v.rule.id),
          now,
        );
        return promptBlockOutput(target, blockReason(verdict.violations, rules));
      }
      const signal = doubtSignal(verdict.doubts);
      return contextOutput(
        target,
        [injectionContext(rules), signal].filter((part) => part !== '').join('\n\n'),
      );
    }
    if (input.continuing || input.lastAnswer === undefined) return nothing;
    const verdict = verdictOf(rules, 'answer', input.lastAnswer);
    if (verdict.violations.length === 0) return nothing;
    auditConversation(
      home,
      'Stop',
      verdict.violations.map((v) => v.rule.id),
      now,
    );
    return stopBlockOutput(
      target,
      `Your answer breaks a governance rule. Correct it now. ${blockReason(verdict.violations, rules)}`,
    );
  } catch {
    recordIncident(home, {
      target,
      hook: kind === 'prompt' ? 'user_prompt_submit' : 'stop',
      code: 'internal_error',
      effect: 'failed_open',
    });
    return nothing;
  }
}
