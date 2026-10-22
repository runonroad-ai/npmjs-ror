/**
 * The managed writer (ADR-0007, SPEC-006 §2-3), the only module of `ror` that writes outside
 * `~/.runonroad`: `write_file`, `managed_block` and `remove_managed`, each write recorded in the
 * lock with its hash. All refusals happen before the first write; the plan-level ones (same path
 * twice, `git_exclude`, `ensure_dir`) belong to the `ror sync` planner.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import type { ContractOperation } from '@runonroad/api-contract';

/** Where one layer writes: the path roots it serves (`project` → the repository) and its lock. */
export interface Layer {
  readonly roots: Readonly<Record<string, string>>;
  readonly lockPath: string;
}

export interface LockEntry {
  readonly path: string;
  readonly block_id?: string;
  readonly sha256: string;
}

export interface Lock {
  readonly version: 1;
  entries: LockEntry[];
}

/** The operation is in the vocabulary, but applying it would leave its root or touch user content. */
export class RefusedOperationError extends Error {
  override readonly name = 'RefusedOperationError';
}

/** An operation of the vocabulary this writer does not execute; nothing is written. */
export class UnsupportedOperationError extends Error {
  override readonly name = 'UnsupportedOperationError';
}

type FileContent = { readonly content: string; readonly mode: number };
/** What a path holds once the apply is done; `null` removes it. */
type Pending = Map<string, FileContent | null>;

const MANAGED_HEADER = 'Managed by RunOnRoad';
const BLOCK_ID = /^[A-Za-z0-9._-]+$/u;
const MARKER_LINE = /(?:^|\n)(?:<!-- |# |\/\/ )runonroad:(?:begin|end) /u;
const COMMENTS = { html: ['<!-- ', ' -->'], hash: ['# ', ''], slash: ['// ', ''] } as const;
const refused = (rooted: string, reason: string) =>
  new RefusedOperationError(`${JSON.stringify(rooted)} ${reason}`);
const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const digest = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** Applies the operations in order, then writes the lock. A refusal throws before any write. */
export function applyManaged(operations: readonly ContractOperation[], layer: Layer): void {
  const lock = readLock(layer.lockPath);
  const pending: Pending = new Map();
  for (const operation of operations) plan(operation, layer, lock, pending);

  for (const [path, file] of pending) {
    if (file === null) fs.rmSync(path, { force: true });
    else writeAtomic(path, file.content, file.mode);
  }
  writeAtomic(layer.lockPath, `${JSON.stringify(lock, null, 2)}\n`, 0o644);
}

export function readLock(lockPath: string): Lock {
  if (!fs.existsSync(lockPath)) return { version: 1, entries: [] };
  return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Lock;
}

function plan(operation: ContractOperation, layer: Layer, lock: Lock, pending: Pending): void {
  switch (operation.op) {
    case 'write_file': {
      const resolved = resolve(operation.path, layer.roots);
      const locked = findEntry(lock, operation.path) !== -1;
      if (!locked && !operation.path.split('/').some((segment) => segment.startsWith('ror-'))) {
        throw refused(operation.path, 'is neither a ror- file nor in the lock');
      }
      const current = read(resolved, operation.path, pending);
      if (current && !locked && !current.content.slice(0, 512).includes(MANAGED_HEADER)) {
        throw refused(operation.path, 'exists and is not managed by RunOnRoad');
      }
      pending.set(resolved, {
        content: operation.content,
        mode: operation.executable === true ? 0o755 : 0o644,
      });
      record(lock, { path: operation.path, sha256: digest(operation.content) });
      return;
    }
    case 'managed_block': {
      const id = operation.block_id;
      if (!BLOCK_ID.test(id)) throw refused(id, 'is not a block id ror writes');
      if (MARKER_LINE.test(operation.content))
        throw refused(id, 'has a block marker in its content');
      const resolved = resolve(operation.path, layer.roots);
      const current = read(resolved, operation.path, pending);
      const [open, close] = COMMENTS[operation.comment_style];
      const body = operation.content.endsWith('\n') ? operation.content : `${operation.content}\n`;
      const block = `${open}runonroad:begin ${id}${close}\n${body}${open}runonroad:end ${id}${close}\n`;
      const next = keepFinalNewline(current?.content ?? '', (text) => {
        const span = locate(text, id, operation.path);
        return span === undefined
          ? `${text}${block}`
          : text.slice(0, span.start) + block + text.slice(span.end);
      });
      pending.set(resolved, { content: next, mode: current?.mode ?? 0o644 });
      record(lock, { path: operation.path, block_id: id, sha256: digest(body) });
      return;
    }
    case 'remove_managed': {
      const { path, block_id: id } = operation;
      if (path === undefined || operation.owner !== undefined) break;
      const index = findEntry(lock, path, id);
      if (index === -1) throw refused(path, 'is not in the lock');
      const resolved = resolve(path, layer.roots, false);
      lock.entries.splice(index, 1);
      if (id === undefined) {
        // A symlink leaf is removed as the link; a folder would throw mid-apply.
        if (fs.lstatSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
          throw refused(path, 'is not a regular file');
        }
        pending.set(resolved, null);
        return;
      }
      const current = read(resolved, path, pending);
      if (current === undefined) return;
      const rest = keepFinalNewline(current.content, (text) => {
        const span = locate(text, id, path);
        return span === undefined ? text : text.slice(0, span.start) + text.slice(span.end);
      });
      // shortcut: a file the block leaves empty is removed, even one empty before ror; record `created` in the lock if that matters.
      if (rest !== current.content) {
        pending.set(resolved, rest === '' ? null : { content: rest, mode: current.mode });
      }
      return;
    }
    default:
  }
  throw new UnsupportedOperationError(`${operation.op} is not an operation this writer executes`);
}

const findEntry = (lock: Lock, path: string, blockId?: string) =>
  lock.entries.findIndex((entry) => entry.path === path && entry.block_id === blockId);

function record(lock: Lock, entry: LockEntry): void {
  const index = findEntry(lock, entry.path, entry.block_id);
  if (index === -1) lock.entries.push(entry);
  else lock.entries[index] = entry;
}

/** The file as the earlier operations of this apply leave it; `undefined` when there is none. */
function read(resolved: string, rooted: string, pending: Pending): FileContent | undefined {
  if (pending.has(resolved)) return pending.get(resolved) ?? undefined;
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isFile()) throw refused(rooted, 'is not a regular file');
  return { content: fs.readFileSync(resolved, 'utf8'), mode: stat.mode & 0o777 };
}

/**
 * Edits `text` as if it ended in a newline; a file without one gets none back, so the `\n` ror
 * puts before a block it appends leaves with that block (ADR-0007: uninstall restores the bytes).
 */
function keepFinalNewline(text: string, edit: (text: string) => string): string {
  if (text === '' || text.endsWith('\n')) return edit(text);
  return edit(`${text}\n`).replace(/\r?\n$/u, '');
}

/**
 * Where block `id` starts and ends, its markers whole lines ending in LF or CRLF (a Git for
 * Windows checkout); a block without its end, or found twice, is refused.
 */
function locate(text: string, id: string, rooted: string) {
  const spans = Object.values(COMMENTS).flatMap(([open, close]) => {
    const marker = (kind: string) =>
      new RegExp(
        `(?<=^|\\n)${escapeRegExp(`${open}runonroad:${kind} ${id}${close}`)}\\r?\\n`,
        'gu',
      );
    const begins = [...text.matchAll(marker('begin'))];
    const start = begins[0]?.index;
    if (start === undefined) return [];
    const end = marker('end');
    end.lastIndex = start;
    const stop = end.exec(text);
    if (stop === null || begins.length > 1) {
      throw refused(rooted, `has a broken or repeated block ${id}`);
    }
    return [{ start, end: stop.index + stop[0].length }];
  });
  if (spans.length > 1) throw refused(rooted, `has block ${id} more than once`);
  return spans[0];
}

/**
 * Maps `${root}/a/b` to a real path inside that root (SPEC-006 §2). Refused: no root, a root
 * this layer does not serve, a `..`, a `.` or empty segment or a trailing slash (unless
 * `canonical` is false: a lock from an older ror may spell a path so), and a path a symlink on
 * the way would carry outside its root. The leaf is never followed: a symlink there is the path.
 */
function resolve(rooted: string, roots: Layer['roots'], canonical = true): string {
  const match = /^\$\{(?<name>[a-z_]+)\}\/(?<rel>.*)$/su.exec(rooted);
  if (match?.groups === undefined) throw refused(rooted, 'has no path root');
  const { name = '', rel = '' } = match.groups;
  const root = roots[name];
  if (root === undefined) throw refused(rooted, 'is under a root this layer does not serve');
  const segments = rel.split('/');
  if (/[\\:\0]/u.test(rel) || segments.includes('..')) throw refused(rooted, 'escapes its root');
  if (canonical && segments.some((segment) => segment === '' || segment === '.')) {
    throw refused(rooted, 'is not in its canonical spelling');
  }
  if (!fs.existsSync(root)) throw refused(rooted, 'is under a root that does not exist');
  const realRoot = fs.realpathSync(root);
  const full = join(realRoot, ...segments);
  let existing = dirname(full);
  while (fs.lstatSync(existing, { throwIfNoEntry: false }) === undefined)
    existing = dirname(existing);
  const resolved = join(fs.realpathSync(existing), relative(existing, full));
  const inside = relative(realRoot, resolved);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw refused(rooted, 'escapes its root');
  }
  return resolved;
}

/** Through a temporary file in the same directory: a reader never sees half a file. */
function writeAtomic(path: string, content: string, mode: number): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.ror-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.renameSync(temporary, path);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
