/**
 * The decision of `ror hook` for one tool call (ADR-0085). Pure but for the
 * file system reads that resolve symbolic links: same policy and same call in,
 * same decision out.
 *
 * What it covers, and what it declares it does not (see status.ts):
 *  - built-in file tools: the path is resolved the way the OS resolves it
 *    (links followed in order, so `link/..` is what it really is) and matched
 *    against every path rule;
 *  - Bash: every simple command is read (shell.ts); a command rule matches when
 *    its executable is in command position (after wrappers such as `env` or
 *    `sudo`), its leading words follow in order and one of its flags is present;
 *    the words and redirection targets that look like paths are matched against
 *    the path rules, by the direction of the access; the OS sandbox covers what
 *    a program does by itself;
 *  - MCP tools: denied unless the server is in `mcp_allow`;
 *  - a tool this client does not know: denied, never guessed;
 *  - RunOnRoad's own files (its state, the policy, the project's Claude settings)
 *    cannot be changed by the agent, whatever the policy says: an agent that could
 *    edit them could lift every rule.
 */
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { settle } from './attest.js';
import { candidatesOf, shellCandidates } from './candidates.js';
import { blockReason, doubtSignal, liveContent, verdictOf } from './conversation.js';
import type { ContentRule, Finding } from '@runonroad/content-rules';
import { parsePowerShell, parseShell, type SimpleCommand } from './shell.js';

export interface PathRule {
  readonly id: string;
  readonly kind: 'path';
  readonly decision: 'forbid' | 'ask';
  readonly reason: string;
  readonly required: boolean;
  readonly access: 'read' | 'write' | 'any';
  readonly glob: string;
}

export interface CommandRule {
  readonly id: string;
  readonly kind: 'command';
  readonly decision: 'forbid' | 'ask';
  readonly reason: string;
  readonly required: boolean;
  readonly executable: string;
  readonly argv_prefix: readonly string[];
  readonly flags_any: readonly string[];
}

export type PolicyRule = PathRule | CommandRule;

export interface PolicyView {
  readonly rules: readonly PolicyRule[];
  /** Content rules (ADR-0088): judged on what is written, never on a path or a command. */
  readonly content?: readonly ContentRule[] | undefined;
  readonly mcp_allow: readonly string[];
  /** Ask-first rules lifted for this person, each until the end of its lease (ADR-0087). */
  readonly derogations?:
    readonly { readonly rule_id: string; readonly expires_at_ms: number }[] | undefined;
}

export interface ToolCall {
  readonly tool_name: string;
  readonly tool_input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  /** The conversation and turn the tool reports, when it does: what an attestation is bound to (ADR-0090). */
  readonly session?: { readonly id: string; readonly turn: string | undefined } | undefined;
  /** The language of a command: Bash unless the tool says otherwise (Windows). */
  readonly shell?: 'posix' | 'powershell' | undefined;
}

export interface Roots {
  readonly project: string;
  readonly home: string;
  /** Codex's configuration directory when it is not `~/.codex`. */
  readonly codexHome?: string | undefined;
  /** Where `ror` keeps its own state on this device. */
  readonly ror: string;
}

export type Verdict =
  | { readonly allow: true; readonly signal?: string | undefined }
  | { readonly allow: false; readonly rule: string | null; readonly reason: string };

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
/** Tools with no effect on files or the network, or governed by their own rules. */
const NEUTRAL_TOOLS = new Set([
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'Task',
  'Agent',
  'Skill',
  'WebFetch',
  'WebSearch',
  'TaskOutput',
  'TaskStop',
  'BashOutput',
  'KillShell',
  'ToolSearch',
]);

const deny = (rule: PolicyRule | null, reason: string): Verdict => ({
  allow: false,
  rule: rule?.id ?? null,
  // an Ask-first rule says how to get past it: the model tells the person, who asks (ADR-0087)
  reason:
    rule?.decision === 'ask'
      ? `${reason} This needs a derogation: tell the person to run \`ror derogation request ${rule.id} --reason "<why>"\` and wait for the approval.`
      : reason,
});

// ------------------------------------------------------- self-protection

const OWN = 'RunOnRoad protects its own files: a person changes them, not the agent';

/** The files that hold the rules up. An agent that could write them could lift every rule. */
export function protectedRules(roots: Roots): PathRule[] {
  const own = (id: string, glob: string, access: PathRule['access']): PathRule => ({
    id: `ror:${id}`,
    kind: 'path',
    decision: 'forbid',
    reason: OWN,
    required: true,
    access,
    glob,
  });
  return [
    own('project-state', join(roots.project, '.runonroad'), 'write'),
    own('project-settings-local', join(roots.project, '.claude', 'settings.local.json'), 'write'),
    own('project-settings', join(roots.project, '.claude', 'settings.json'), 'write'),
    own('user-settings', join(roots.home, '.claude', 'settings.json'), 'write'),
    // the device token lives here: not even read
    own('device-state', roots.ror, 'any'),
    // the other tools' own configuration, where ror registers its hooks and rules
    own(
      'codex-config',
      join(roots.codexHome ?? join(roots.home, '.codex'), 'config.toml'),
      'write',
    ),
    own('codex-hooks', join(roots.codexHome ?? join(roots.home, '.codex'), 'hooks.json'), 'write'),
    own('codex-rules', join(roots.codexHome ?? join(roots.home, '.codex'), 'rules'), 'write'),
    own('cursor-hooks', join(roots.home, '.cursor', 'hooks.json'), 'write'),
    own('cursor-cli', join(roots.home, '.cursor', 'cli-config.json'), 'write'),
    own('project-cursor-hooks', join(roots.project, '.cursor', 'hooks.json'), 'write'),
  ];
}

// ----------------------------------------------------------------- paths

/**
 * The path the OS reaches: components are walked in order, a link is followed
 * where it stands, `..` goes up from where it really is. A dangling link leads
 * to the place it points at. `resolve()` alone would fold `link/..` first.
 */
/** A backslash separates path parts only on Windows; on POSIX it is a legal file name character. */
const PATH_SEPARATOR = platform() === 'win32' ? /[\\/]/u : /\//u;

function physical(raw: string): string {
  // the root is the system's own: `/` here, `C:\\` or a UNC share on Windows
  const { root } = parse(raw);
  let pending = raw
    .slice(root.length)
    .split(PATH_SEPARATOR)
    .filter((part) => part !== '');
  let current = root === '' ? '/' : root;
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() ?? '';
    if (part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      // it does not exist: whatever is left cannot be a link
      return resolve(next, ...pending);
    }
    if (!isLink) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > 40) return resolve(raw);
    const target = readlinkSync(next);
    const targetRoot = isAbsolute(target) ? parse(target).root : '';
    if (targetRoot !== '') current = targetRoot;
    pending = [
      ...target
        .slice(targetRoot.length)
        .split(PATH_SEPARATOR)
        .filter((piece) => piece !== ''),
      ...pending,
    ];
  }
  return current;
}

/**
 * One spelling per file for the match: NFC, `/` as the separator (Windows writes `\`),
 * and folded where the file system folds. Exported with the system as an argument so
 * every system's spelling is tested on any machine.
 */
export function canonicalPath(path: string, os: NodeJS.Platform = platform()): string {
  let normal = path.normalize('NFC');
  if (os === 'win32') normal = normal.replace(/^\\\\\?\\/u, '').replaceAll('\\', '/');
  normal = normal.replace(/\/+$/u, '');
  return os === 'darwin' || os === 'win32' ? normal.toLowerCase() : normal;
}
const canonical = (path: string): string => canonicalPath(path);

export function globToRegExp(raw: string, os: NodeJS.Platform = platform()): RegExp {
  // `dir/**` and `dir/` are the directory itself and everything below it: one spelling first, since
  // Windows joins with `\`, then the tail is cut
  const glob = canonicalPath(raw, os).replace(/\/\*\*$/u, '');
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? '';
    if (char === '*' && glob[index + 1] === '*') {
      // `**/` is zero or more directories; a trailing `**` is everything below
      index += 1;
      if (glob[index + 1] === '/') {
        source += '(?:.*/)?';
        index += 1;
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  // a glob without a wildcard names a path and everything below it
  return new RegExp(`^${source}(?:/.*)?$`, 'u');
}

function absoluteGlob(glob: string, roots: Roots): string {
  if (glob.startsWith('~/')) return join(roots.home, glob.slice(2));
  if (isAbsolute(glob)) return glob;
  return join(roots.project, glob);
}

/** The path as written and the path it really is: a link to a denied file is denied. */
function spellings(path: string, cwd: string): string[] {
  // concatenated, not joined: `link/..` must reach the OS as written, not folded by the library
  const raw = isAbsolute(path) ? path : `${cwd}/${path}`;
  return [...new Set([resolve(raw), physical(raw)])];
}

// the three roots are resolved on disk once per Roots object, not once per rule and argument (hook latency, ADR-0008).
// A Roots object lives for one evaluation (the hook builds a fresh one per call): never keep one across a change of the links.
const PHYSICAL_ROOTS = new WeakMap<Roots, Roots>();
function physicalRoots(roots: Roots): Roots {
  let found = PHYSICAL_ROOTS.get(roots);
  if (found === undefined) {
    found = {
      project: physical(roots.project),
      home: physical(roots.home),
      ror: physical(roots.ror),
    };
    PHYSICAL_ROOTS.set(roots, found);
  }
  return found;
}

function matchesPath(rule: PathRule, path: string, cwd: string, roots: Roots): boolean {
  const candidates = spellings(path, cwd);
  // a project or home reached through a link (`/var` is `/private/var` on macOS, a linked workspace)
  // is the same place under both spellings: the glob is read under each, never under one only
  const places = [roots, physicalRoots(roots)];
  return places.some((place) => {
    const pattern = globToRegExp(absoluteGlob(rule.glob, place));
    return candidates.some((candidate) => pattern.test(canonical(candidate)));
  });
}

const touches = (rule: PathRule, wants: 'read' | 'write'): boolean =>
  rule.access === 'any' || rule.access === wants;

// -------------------------------------------------------------- commands

/** The program a word names: its file name, without the extension Windows adds, folded where names are. */
export function programName(word: string, os: NodeJS.Platform = platform()): string {
  const name = os === 'win32' ? (word.split(/[\\/]/u).at(-1) ?? word) : basename(word);
  return os === 'win32' ? name.replace(/\.(?:exe|cmd|bat|com|ps1)$/iu, '').toLowerCase() : name;
}
const base = (word: string): string => programName(word);

/** Programs that run the command that follows them. */
const WRAPPERS = new Set([
  'env',
  'sudo',
  'doas',
  'command',
  'builtin',
  'exec',
  'nice',
  'nohup',
  'time',
  'timeout',
  'xargs',
  'setsid',
  'stdbuf',
  'watch',
  'ionice',
  'flock',
  'npx',
  'unbuffer',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/u;

/**
 * Where a command can start in a simple command: the first word, and the words
 * after a wrapper (`sudo -u bob git`: at most two unknown words between them).
 * `echo git push` has no wrapper, so `git` there is text.
 */
function commandPositions(words: readonly string[]): number[] {
  const positions: number[] = [];
  let wrapped = false;
  let free = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (index === 0 || (wrapped && free <= 2)) positions.push(index);
    if (WRAPPERS.has(base(word))) wrapped = true;
    else if (!(word.startsWith('-') || ASSIGNMENT.test(word) || DURATION.test(word))) {
      free += 1;
      if (!wrapped) break;
    }
    if (free > 2) break;
  }
  return positions;
}

function flagPresent(words: readonly string[], flag: string): boolean {
  const long = flag.startsWith('--');
  return words.some((word) => {
    if (long) return word === flag || word.startsWith(`${flag}=`);
    if (word === flag) return true;
    // a cluster of short flags: -fu contains -f
    return /^-[A-Za-z]{2,}$/u.test(word) && word.includes(flag.slice(1));
  });
}

function matchesCommand(rule: CommandRule, words: readonly string[]): boolean {
  for (const at of commandPositions(words)) {
    if (base(words[at] ?? '') !== rule.executable) continue;
    const rest = words.slice(at + 1);
    let cursor = 0;
    let ordered = true;
    for (const token of rule.argv_prefix) {
      const found = rest.findIndex(
        (word, index) => index >= cursor && !word.startsWith('-') && word === token,
      );
      if (found < 0) {
        ordered = false;
        break;
      }
      cursor = found + 1;
    }
    if (
      ordered &&
      (rule.flags_any.length === 0 || rule.flags_any.some((flag) => flagPresent(rest, flag)))
    ) {
      return true;
    }
  }
  return false;
}

/** Programs whose arguments are files they change. */
const WRITERS = new Set([
  'tee',
  'cp',
  'mv',
  'rm',
  'touch',
  'mkdir',
  'rmdir',
  'truncate',
  'install',
  'ln',
  'chmod',
  'chown',
  'shred',
  'unlink',
  'rsync',
]);

// a path `join` wrote on Windows has `\` only, and starts with a drive: PATH_SEPARATOR and isAbsolute see both
const looksLikePath = (word: string): boolean =>
  PATH_SEPARATOR.test(word) || isAbsolute(word) || word.startsWith('.') || word.startsWith('~');

function expandHome(word: string, roots: Roots): string {
  if (word === '~') return roots.home;
  return word.startsWith('~/') ? join(roots.home, word.slice(2)) : word;
}

/** The words a command may read and the words it may write, as far as a reader can tell. */
function accessedWords(simple: SimpleCommand): { read: string[]; write: string[] } {
  const args = simple.words.slice(1);
  const names = commandPositions(simple.words).map((index) => base(simple.words[index] ?? ''));
  const writes = names.some((name) => WRITERS.has(name));
  const inPlace =
    names.includes('sed') && args.some((word) => /^-[A-Za-z]*i|^--in-place/u.test(word));
  const dd = args.flatMap((word) => (word.startsWith('of=') ? [word.slice(3)] : []));
  return {
    read: [...args, ...simple.redirects.filter((r) => r.access === 'read').map((r) => r.target)],
    write: [
      ...simple.redirects.filter((r) => r.access === 'write').map((r) => r.target),
      ...(writes || inPlace ? args : []),
      ...dd,
    ],
  };
}

function evaluateShell(command: string, policy: PolicyView, call: ToolCall, roots: Roots): Verdict {
  let simples: SimpleCommand[];
  if (call.shell === 'powershell') {
    const parsed = parsePowerShell(command, call.cwd);
    // a rule that cannot be checked against a form this reader does not interpret is not waved through
    if (parsed === undefined) {
      return deny(
        null,
        'RunOnRoad cannot read this PowerShell command well enough to check the rules',
      );
    }
    simples = parsed;
  } else simples = parseShell(command, call.cwd);
  for (const simple of simples) {
    for (const rule of policy.rules) {
      if (rule.kind === 'command' && matchesCommand(rule, simple.words)) {
        return deny(rule, rule.reason);
      }
    }
    const { read, write } = accessedWords(simple);
    // a `cd` in a subshell does not carry out of it, so the line is read from both directories
    const directories = [...new Set([simple.cwd, call.cwd])];
    for (const rule of policy.rules) {
      if (rule.kind !== 'path') continue;
      const words =
        rule.access === 'read' ? read : rule.access === 'write' ? write : [...read, ...write];
      for (const word of words) {
        const text = expandHome(word, roots);
        for (const directory of directories) {
          if (
            (looksLikePath(text) || existsSync(resolve(directory, text))) &&
            matchesPath(rule, text, directory, roots)
          ) {
            return deny(rule, rule.reason);
          }
        }
      }
    }
  }
  return { allow: true };
}

// ------------------------------------------------------------------ entry

function fileOf(input: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** The part of a Glob pattern before its first wildcard: where the search really starts. */
function staticPrefix(pattern: unknown): string {
  if (typeof pattern !== 'string') return '';
  const fixed: string[] = [];
  for (const part of pattern.split('/')) {
    if (/[*?[{]/u.test(part)) break;
    fixed.push(part);
  }
  return fixed.join('/');
}

/** The rules a call is judged by: an Ask-first rule is off while its lease runs, never a `forbid`. */
function liveRules(policy: PolicyView, nowMs: number): PolicyRule[] {
  const lifted = new Set(
    (policy.derogations ?? [])
      .filter((derogation) => derogation.expires_at_ms > nowMs)
      .map((derogation) => derogation.rule_id),
  );
  return policy.rules.filter((rule) => !(rule.decision === 'ask' && lifted.has(rule.id)));
}

/**
 * The files an `apply_patch` touches, from Codex's patch grammar. Anything the
 * grammar does not know is undefined: the caller refuses what it cannot read.
 */
export function patchPaths(patch: string): string[] | undefined {
  const lines = patch.replace(/\r\n?/gu, '\n').split('\n');
  if (lines[0]?.trim() !== '*** Begin Patch') return undefined;
  const paths: string[] = [];
  let ended = false;
  for (const line of lines.slice(1)) {
    if (ended) {
      if (line.trim() !== '') return undefined;
      continue;
    }
    if (line.trim() === '*** End Patch') {
      ended = true;
      continue;
    }
    const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/u.exec(line);
    if (header !== null) paths.push((header[2] ?? '').trim());
    else if (line.startsWith('*** ') && line.trim() !== '*** End of File') return undefined;
  }
  return ended && paths.length > 0 ? paths : undefined;
}

/** What the write would leave in the file, judged by the content rules in force. */
function contentVerdict(policy: PolicyView, call: ToolCall, nowMs: number, home: string): Verdict {
  const rules = liveContent(policy.content ?? [], policy.derogations ?? [], nowMs).filter((rule) =>
    rule.scopes.includes('file_write'),
  );
  if (rules.length === 0) return { allow: true };
  const candidates = candidatesOf(call);
  if (candidates === undefined) {
    return deny(
      null,
      'RunOnRoad could not rebuild what this change would leave in the file, so it cannot check it against the content rules: write the whole file instead',
    );
  }
  const violations: Finding[] = [];
  const doubts: Finding[] = [];
  for (const candidate of candidates) {
    const verdict = verdictOf(rules, 'file_write', candidate.content);
    violations.push(...verdict.violations);
    doubts.push(...verdict.doubts);
  }
  const first = violations[0];
  if (first !== undefined) {
    return { allow: false, rule: first.rule.id, reason: blockReason(violations, rules) };
  }
  return settleDoubts(
    home,
    call,
    candidates.map((candidate) => candidate.content),
    doubts,
    nowMs,
  );
}

/**
 * What code could not decide is put to the AI as a question with proof (attest.ts); without a
 * conversation to bind the answer to, it stays a signal.
 */
function settleDoubts(
  home: string,
  call: ToolCall,
  texts: readonly string[],
  doubts: readonly Finding[],
  nowMs: number,
): Verdict {
  const first = doubts[0];
  if (first === undefined) return { allow: true };
  if (call.session === undefined) {
    const signal = doubtSignal(doubts);
    return signal === '' ? { allow: true } : { allow: true, signal };
  }
  const settled = settle(home, call.session, texts, doubts, nowMs);
  return settled.state === 'attested'
    ? { allow: true }
    : { allow: false, rule: first.rule.id, reason: settled.message };
}

/** A shell command that writes a file: its own text and the files it copies are judged like a write. */
function shellContentVerdict(
  policy: PolicyView,
  call: ToolCall,
  nowMs: number,
  home: string,
): Verdict {
  const rules = liveContent(policy.content ?? [], policy.derogations ?? [], nowMs).filter((rule) =>
    rule.scopes.includes('file_write'),
  );
  if (rules.length === 0) return { allow: true };
  const violations: Finding[] = [];
  const doubts: Finding[] = [];
  const { texts, unreadable } = shellCandidates(call);
  if (unreadable) {
    return deny(
      null,
      'RunOnRoad could not read what this command copies or rewrites (a file that is too large, or a sed script it does not understand), so it cannot check it against the content rules: write the file with the editor tools instead',
    );
  }
  for (const text of texts) {
    const verdict = verdictOf(rules, 'file_write', text);
    violations.push(...verdict.violations);
    doubts.push(...verdict.doubts);
  }
  const first = violations[0];
  if (first !== undefined) {
    return { allow: false, rule: first.rule.id, reason: blockReason(violations, rules) };
  }
  return settleDoubts(home, call, texts, doubts, nowMs);
}

export function evaluate(
  policy: PolicyView,
  call: ToolCall,
  roots: Roots,
  nowMs: number = Date.now(),
): Verdict {
  const { tool_name: tool, tool_input: input } = call;
  const rules: readonly PolicyRule[] = [...protectedRules(roots), ...liveRules(policy, nowMs)];
  const view: PolicyView = { rules, mcp_allow: policy.mcp_allow };

  if (tool === 'apply_patch') {
    const patch = input['command'] ?? input['patch'] ?? input['input'];
    const paths = typeof patch === 'string' ? patchPaths(patch) : undefined;
    if (paths === undefined)
      return deny(null, 'RunOnRoad could not read this patch, so it is refused');
    for (const path of paths) {
      for (const rule of rules) {
        // a patch reads what it updates and writes what it changes: any path rule on the file applies
        if (rule.kind === 'path' && matchesPath(rule, path, call.cwd, roots)) {
          return deny(rule, rule.reason);
        }
      }
    }
    return contentVerdict(policy, call, nowMs, roots.ror);
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = input['command'];
    if (typeof command !== 'string') return deny(null, 'RunOnRoad could not read this command');
    const shellCall = tool === 'PowerShell' ? { ...call, shell: 'powershell' as const } : call;
    const shell = evaluateShell(command, view, shellCall, roots);
    return shell.allow ? shellContentVerdict(policy, shellCall, nowMs, roots.ror) : shell;
  }

  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const wants = READ_TOOLS.has(tool) ? 'read' : 'write';
    // Grep and Glob without a path search the working directory
    const path = fileOf(input) ?? (READ_TOOLS.has(tool) ? '.' : undefined);
    if (path === undefined) return deny(null, 'RunOnRoad could not read the path of this call');
    const searched = [path];
    // `Glob vault/**` names the vault in its pattern, whatever its base directory is
    if (tool === 'Glob') {
      const from = isAbsolute(path) ? path : `${call.cwd}/${path}`;
      searched.push(join(from, staticPrefix(input['pattern'])));
    }
    for (const rule of rules) {
      if (rule.kind !== 'path' || !touches(rule, wants)) continue;
      if (searched.some((candidate) => matchesPath(rule, candidate, call.cwd, roots))) {
        return deny(rule, rule.reason);
      }
    }
    return wants === 'write' ? contentVerdict(policy, call, nowMs, roots.ror) : { allow: true };
  }

  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1] ?? '';
    return policy.mcp_allow.includes(server)
      ? { allow: true }
      : deny(null, `the MCP server "${server}" is not allowed by the organization`);
  }

  if (NEUTRAL_TOOLS.has(tool)) return { allow: true };
  return deny(
    null,
    `RunOnRoad does not cover the tool "${tool}": it is refused rather than guessed`,
  );
}

/** Tools that only talk to the person or track the agent's own work: they act on nothing. */
const INERT_TOOLS = new Set([
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'TaskOutput',
  'TaskStop',
  'BashOutput',
  'KillShell',
  'ToolSearch',
]);

/**
 * What a call may do when the policy cannot be trusted: read files, and talk to
 * the person. No shell, no write, no MCP, no network, and no delegation to a
 * subagent or a skill (they would be governed by this same hook, but there is
 * no reason to start them without rules).
 */
export function evaluateWithoutPolicy(call: ToolCall, why: string, roots: Roots): Verdict {
  const own = evaluate({ rules: [], mcp_allow: [] }, call, roots);
  if (!own.allow) return own;
  const { tool_name: tool } = call;
  if (READ_TOOLS.has(tool) || INERT_TOOLS.has(tool)) return { allow: true };
  return deny(null, `the RunOnRoad policy is not usable (${why}): only reading is allowed`);
}
