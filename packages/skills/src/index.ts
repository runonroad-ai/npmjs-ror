/**
 * The skills of a person's library (ADR-0095, ADR-0096, SPEC-018), as pure functions the API and
 * `ror` share: the tree of text files, its canonical digest, the rules every tree obeys, the
 * validation profile of ADR-0095 and the secret scan that runs before anything is sent.
 *
 * No I/O and no clock. A finding carries a closed code and a file path, never the text it found:
 * an error message cannot copy a secret (ADR-0012).
 */
import { createHash } from 'node:crypto';

export const MAX_FILES = 64;
export const MAX_FILE_BYTES = 262_144;
export const MAX_TREE_BYTES = 1_048_576;
export const MAX_PATH_LENGTH = 200;
/** The folder prefix of a library skill in a tool's discovery root (ADR-0007: `ror-` is ours). */
export const LIBRARY_FOLDER_PREFIX = 'ror-lib-';
export const SKILL_FILE = 'SKILL.md';

export interface SkillFileInput {
  readonly path: string;
  readonly content: string;
}

export type FindingCode =
  | 'skill_md_missing'
  | 'too_many_files'
  | 'file_too_large'
  | 'tree_too_large'
  | 'path_invalid'
  | 'path_collision'
  | 'content_not_text'
  | 'frontmatter_invalid'
  | 'hooks_forbidden'
  | 'delegation_forbidden'
  | 'allowed_tools_forbidden'
  | 'shell_expansion_forbidden'
  | 'secret_suspected'
  | 'rule_violation';

export interface Finding {
  readonly code: FindingCode;
  readonly file?: string;
  /** The id of the governance rule a `rule_violation` is about: a name, never the text that broke it. */
  readonly rule?: string;
}

const PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,5}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/u;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export function isSlug(value: string): boolean {
  return SLUG.test(value);
}

/** The slug a name becomes: lower case, ASCII, dashes; empty when nothing usable is left. */
export function slugOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/u, '');
}

export function validPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || !PATH.test(path)) return false;
  return !path.split('/').some((part) => part === '.' || part === '..');
}

/** The folder the tool discovers the skill in. */
export function folderOf(slug: string): string {
  return `${LIBRARY_FOLDER_PREFIX}${slug}`;
}

export function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

export function fileDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The digest of the whole tree: path and content of each file, in path order, nothing else. */
export function treeDigest(files: readonly SkillFileInput[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\0${fileDigest(file.content)}\n`, 'utf8');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** The rules every tree obeys, whoever wrote it. */
export function checkTree(files: readonly SkillFileInput[]): Finding[] {
  const findings: Finding[] = [];
  if (files.length > MAX_FILES) findings.push({ code: 'too_many_files' });
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (!validPath(file.path)) {
      findings.push({ code: 'path_invalid' });
      continue;
    }
    const folded = file.path.toLowerCase();
    if (seen.has(folded)) findings.push({ code: 'path_collision', file: file.path });
    seen.add(folded);
    if (CONTROL.test(file.content) || file.content.includes('�')) {
      findings.push({ code: 'content_not_text', file: file.path });
    }
    const size = byteLength(file.content);
    total += size;
    if (size > MAX_FILE_BYTES) findings.push({ code: 'file_too_large', file: file.path });
  }
  if (total > MAX_TREE_BYTES) findings.push({ code: 'tree_too_large' });
  if (!files.some((file) => file.path === SKILL_FILE)) findings.push({ code: 'skill_md_missing' });
  return findings;
}

interface Frontmatter {
  readonly keys: ReadonlySet<string>;
  readonly body: string;
}

/** `---` fenced block at the top of SKILL.md; its top-level keys only, as the profile needs nothing else. */
function frontmatterOf(text: string): Frontmatter | 'invalid' {
  if (!text.startsWith('---')) return { keys: new Set(), body: text };
  const lines = text.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return 'invalid';
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return 'invalid';
  const keys = new Set<string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:/u.exec(line);
    if (match?.[1] !== undefined) keys.add(match[1].toLowerCase());
  }
  return { keys, body: lines.slice(end + 1).join('\n') };
}

/**
 * The one-line value of a key of SKILL.md's header (`description: Write a quote`), trimmed of its quotes
 * and cut to `max` characters; empty when there is none. A plain reading, as the profile's: the header
 * is never evaluated.
 */
export function headerValue(files: readonly SkillFileInput[], key: string, max = 300): string {
  const skill = files.find((file) => file.path === SKILL_FILE);
  if (skill === undefined || !skill.content.startsWith('---')) return '';
  const lines = skill.content.split(/\r?\n/u);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return '';
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(line);
    if (match?.[1]?.toLowerCase() === key.toLowerCase()) {
      return (match[2] ?? '')
        .trim()
        .replace(/^["']|["']$/gu, '')
        .slice(0, max);
    }
  }
  return '';
}

const HOOK_KEYS = ['hooks', 'mcp', 'mcpservers', 'mcp-servers'];
const DELEGATION_KEYS = ['context', 'agent', 'subagent'];

/**
 * ADR-0095's validation profile for this slice: text only, no hooks, no MCP servers, no
 * delegation, no widening of `allowed-tools` (refused outright until a decision admits it), and
 * no shell expansion in the body (`!` followed by a backtick span, or a fenced block that opens
 * with `!`).
 */
export function profileFindings(files: readonly SkillFileInput[]): Finding[] {
  const skill = files.find((file) => file.path === SKILL_FILE);
  if (skill === undefined) return [];
  const front = frontmatterOf(skill.content);
  if (front === 'invalid') return [{ code: 'frontmatter_invalid', file: SKILL_FILE }];
  const findings: Finding[] = [];
  if (HOOK_KEYS.some((key) => front.keys.has(key))) {
    findings.push({ code: 'hooks_forbidden', file: SKILL_FILE });
  }
  if (DELEGATION_KEYS.some((key) => front.keys.has(key))) {
    findings.push({ code: 'delegation_forbidden', file: SKILL_FILE });
  }
  if (front.keys.has('allowed-tools') || front.keys.has('allowed_tools')) {
    findings.push({ code: 'allowed_tools_forbidden', file: SKILL_FILE });
  }
  for (const file of files) {
    const text = file.path === SKILL_FILE ? front.body : file.content;
    if (/!`[^`\n]+`/u.test(text) || /^\s*```!/mu.test(text)) {
      findings.push({ code: 'shell_expansion_forbidden', file: file.path });
    }
  }
  return findings;
}

const SECRETS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u,
  /\bsk-[A-Za-z0-9_-]{24,}\b/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[A-Za-z0-9/+=_-]{16,}["']?/iu,
];

/** A file that looks like it carries a secret; the match itself is never returned. */
export function secretFindings(files: readonly SkillFileInput[]): Finding[] {
  return files
    .filter((file) => SECRETS.some((pattern) => pattern.test(file.content)))
    .map((file) => ({ code: 'secret_suspected' as const, file: file.path }));
}
