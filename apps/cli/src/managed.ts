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

import {
  deleteAt,
  getAt,
  isObject,
  overlaps,
  PointerError,
  sameJson,
  segmentsOf,
  setAt,
  type JsonObject,
} from './json-pointer.js';
import { isTopLevelToml, tomlConflict } from './toml-keys.js';

/** Where one layer writes: the path roots it serves (`project` → the repository) and its lock. */
export interface Layer {
  readonly roots: Readonly<Record<string, string>>;
  readonly lockPath: string;
}

/** What undoes one `merge_json` exactly (ADR-0119 point 3): what was there, and what `ror` created. */
export interface JsonUndo {
  readonly values?: readonly unknown[];
  readonly had_previous?: boolean;
  readonly previous?: unknown;
  readonly created_file?: boolean;
  readonly created_parents?: readonly string[];
  readonly created_array?: boolean;
}

/**
 * One thing `ror` wrote. An entry is a file (no `block_id`), a block, or, only when the caller asked
 * for the extended operations (ADR-0119), a `json` edit (`block_id` is `json:<pointer>`) or a `dir`
 * (`block_id` is `dir:`): neither can be taken for a file or a block by a reader that ignores `kind`.
 */
export interface LockEntry extends JsonUndo {
  readonly path: string;
  readonly block_id?: string;
  readonly sha256: string;
  readonly kind?: 'dir' | 'json';
  readonly pointer?: string;
  readonly strategy?: 'set' | 'append_unique';
  /** First lock of an interrupted apply: the entry is new and may not be applied yet. */
  readonly pending?: boolean;
  /** First lock of an interrupted apply: what the entry becomes, next to what it was. */
  readonly next?: JsonUndo;
}

/** What the lock says about the apply that wrote it (facultative, read by `status` and `sync`). */
export interface LockMeta {
  readonly target?: string;
  readonly effective_hash?: string;
  readonly organization_id?: string;
  readonly issued_at?: string;
  readonly applied_at?: string;
}

export interface Lock extends LockMeta {
  readonly version: 1;
  entries: LockEntry[];
}

export interface ApplyOptions {
  /** Executes `ensure_dir` and `merge_json` too (ADR-0119): without it they are refused, as before. */
  readonly extended?: boolean;
  /** Retires what an earlier apply wrote and this one no longer produces, if it is still unchanged. */
  readonly retire?: 'unchanged-only';
  readonly meta?: LockMeta;
  /** Removes the lock file when nothing is left in it (uninstall). */
  readonly dropEmptyLock?: boolean;
}

export interface ApplyResult {
  /** Rooted paths whose bytes changed. */
  readonly written: readonly string[];
  readonly unchanged: number;
  readonly removed: readonly string[];
  /** Entries a person edited since: still owned, still in the lock, never destroyed. */
  readonly kept: readonly string[];
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

export const MANAGED_HEADER = 'Managed by RunOnRoad';
const BLOCK_ID = /^[A-Za-z0-9._-]+$/u;
const MARKER_LINE = /(?:^|\n)(?:<!-- |# |\/\/ )runonroad:(?:begin|end) /u;
const COMMENTS = { html: ['<!-- ', ' -->'], hash: ['# ', ''], slash: ['// ', ''] } as const;
const refused = (rooted: string, reason: string) =>
  new RefusedOperationError(`${JSON.stringify(rooted)} ${reason}`);
const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const digest = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** What one apply has planned, before the first write. */
interface State {
  readonly layer: Layer;
  readonly options: ApplyOptions;
  readonly previous: Lock;
  readonly lock: Lock;
  readonly pending: Pending;
  readonly docs: Map<string, JsonDoc>;
  readonly dirsToCreate: string[];
  readonly dirsToRemove: { resolved: string; rooted: string }[];
  readonly touched: Set<string>;
  readonly removed: string[];
  readonly kept: string[];
  /** Resolved paths of JSON files a retired entry says `ror` created. */
  readonly createdFiles: Set<string>;
  /** Resolved path of a JSON file → the objects a retired entry says `ror` created in it. */
  readonly createdParents: Map<string, Set<string>>;
}

/** A JSON file as the apply leaves it, one object per file however many pointers it holds. */
interface JsonDoc {
  readonly rooted: string;
  readonly obj: JsonObject;
  readonly before: string | undefined;
  readonly mode: number;
  /** The key of the entry that creates the file, when there is none. */
  claimed?: string;
  remove: boolean;
}

const entryKey = (entry: { path: string; block_id?: string }) =>
  `${entry.path}#${entry.block_id ?? ''}`;
const jsonId = (pointer: string) => `json:${pointer}`;
const DIR_ID = 'dir:';
const UNDO_KEYS = [
  'values',
  'had_previous',
  'previous',
  'created_file',
  'created_parents',
  'created_array',
] as const;

/**
 * Applies the operations in order, then writes the lock. A refusal throws before any write — the
 * lock included. With `options.retire`, what an earlier apply wrote and this one no longer
 * produces is taken back if it is still what the lock says (ADR-0119 point 5).
 */
/**
 * Windows has no POSIX owner/group/execute bits (a file reads 0o666 or 0o444): there only writability is a
 * difference (the read-only attribute), so a read-only file is not the writable one the plan asks for.
 */
export function sameMode(
  actual: number,
  wanted: number,
  os: NodeJS.Platform = process.platform,
): boolean {
  if (os === 'win32') return (actual & 0o200) === (wanted & 0o200);
  return (actual & 0o777) === wanted;
}

export function applyManaged(
  operations: readonly ContractOperation[],
  layer: Layer,
  options: ApplyOptions = {},
): ApplyResult {
  const previous = readLock(layer.lockPath);
  const lock: Lock = { ...previous, ...options.meta, entries: [...previous.entries] };
  const state: State = {
    layer,
    options,
    previous,
    lock,
    pending: new Map(),
    docs: new Map(),
    dirsToCreate: [],
    dirsToRemove: [],
    touched: new Set(),
    removed: [],
    kept: [],
    createdFiles: new Set(),
    createdParents: new Map(),
  };
  for (const operation of operations) plan(operation, state);
  if (options.retire === 'unchanged-only') retireStale(state);
  renderDocs(state);

  const intent = intentLock(state);
  if (intent !== undefined)
    writeAtomic(layer.lockPath, `${JSON.stringify(intent, null, 2)}\n`, 0o644);

  const written: string[] = [];
  let unchanged = 0;
  for (const dir of state.dirsToCreate) fs.mkdirSync(dir, { recursive: true });
  for (const [path, file] of state.pending) {
    if (file === null) {
      if (fs.lstatSync(path, { throwIfNoEntry: false }) !== undefined) written.push(path);
      fs.rmSync(path, { force: true });
      continue;
    }
    const stat = fs.lstatSync(path, { throwIfNoEntry: false });
    if (
      stat?.isFile() === true &&
      sameMode(stat.mode, file.mode) &&
      fs.readFileSync(path, 'utf8') === file.content
    ) {
      unchanged += 1;
      continue;
    }
    writeAtomic(path, file.content, file.mode);
    written.push(path);
  }
  for (const { resolved } of state.dirsToRemove) fs.rmdirSync(resolved);

  if (options.dropEmptyLock === true && lock.entries.length === 0) {
    fs.rmSync(layer.lockPath, { force: true });
  } else {
    writeAtomic(layer.lockPath, `${JSON.stringify(lock, null, 2)}\n`, 0o644);
  }
  return { written, unchanged, removed: state.removed, kept: state.kept };
}

/** Takes back everything the lock names that is still unchanged; what a person edited stays. */
export function uninstallManaged(layer: Layer): ApplyResult {
  return applyManaged([], layer, {
    extended: true,
    retire: 'unchanged-only',
    dropEmptyLock: true,
  });
}

export function readLock(lockPath: string): Lock {
  if (!fs.existsSync(lockPath)) return { version: 1, entries: [] };
  return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Lock;
}

/** The rooted paths whose content is not what the lock says `ror` wrote. Reads only. */
export function driftOf(layer: Layer): string[] {
  const drifted: string[] = [];
  for (const entry of readLock(layer.lockPath).entries) {
    if (entry.kind === 'dir') continue;
    try {
      if (!stillAsWritten(entry, layer)) drifted.push(entry.path);
    } catch {
      drifted.push(entry.path);
    }
  }
  return drifted;
}

function stillAsWritten(entry: LockEntry, layer: Layer): boolean {
  const resolved = resolve(entry.path, layer.roots, false);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  if (!stat.isFile()) return false;
  const text = fs.readFileSync(resolved, 'utf8');
  if (entry.kind === 'json') {
    if (entry.pointer === undefined) return false;
    const parsed = parseJsonObject(text);
    if (parsed === undefined) return false;
    const current = getAt(parsed, entry.pointer);
    if (entry.strategy === 'set') return sameJson(current, entry.values?.[0]);
    return (
      Array.isArray(current) &&
      (entry.values ?? []).every((value) =>
        (current as unknown[]).some((item) => sameJson(item, value)),
      )
    );
  }
  if (entry.block_id === undefined) return digest(text) === entry.sha256;
  const body = blockBody(text, entry.block_id, entry.path);
  return body !== undefined && digest(body) === entry.sha256;
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The text between the markers of a block, as `ror` wrote it (LF), for hashing. */
function blockBody(text: string, id: string, rooted: string): string | undefined {
  const span = locate(text, id, rooted);
  if (span === undefined) return undefined;
  const lines = text.slice(span.start, span.end).replaceAll('\r\n', '\n').split('\n');
  // first line: begin marker; last two: end marker and the empty string after its newline
  return lines
    .slice(1, -2)
    .map((line) => `${line}\n`)
    .join('');
}

function record(state: State, entry: LockEntry): void {
  const index = findEntry(state.lock, entry.path, entry.block_id);
  if (index === -1) state.lock.entries.push(entry);
  else state.lock.entries[index] = entry;
  state.touched.add(entryKey(entry));
}

function plan(operation: ContractOperation, state: State): void {
  const { layer, lock, pending } = state;
  switch (operation.op) {
    case 'write_file': {
      const resolved = resolve(operation.path, layer.roots);
      const locked = findEntry(lock, operation.path) !== -1;
      // the `.runonroad/` folder of a project is `ror`'s own (ADR-0119 point 3 ter): the signed policy lives there
      const ownFolder = operation.path.startsWith('${project}/.runonroad/');
      if (
        !locked &&
        !ownFolder &&
        !operation.path.split('/').some((segment) => segment.startsWith('ror-'))
      ) {
        throw refused(operation.path, 'is neither a ror- file nor in the lock');
      }
      refuseJsonDoc(state, resolved, operation.path);
      const current = read(resolved, operation.path, pending);
      if (current && !locked && !current.content.slice(0, 512).includes(MANAGED_HEADER)) {
        throw refused(operation.path, 'exists and is not managed by RunOnRoad');
      }
      pending.set(resolved, {
        content: operation.content,
        mode: operation.executable === true ? 0o755 : 0o644,
      });
      record(state, { path: operation.path, sha256: digest(operation.content) });
      return;
    }
    case 'managed_block': {
      const id = operation.block_id;
      if (!BLOCK_ID.test(id)) throw refused(id, 'is not a block id ror writes');
      if (MARKER_LINE.test(operation.content))
        throw refused(id, 'has a block marker in its content');
      const resolved = resolve(operation.path, layer.roots);
      refuseJsonDoc(state, resolved, operation.path);
      const current = read(resolved, operation.path, pending);
      const [open, close] = COMMENTS[operation.comment_style];
      const body = operation.content.endsWith('\n') ? operation.content : `${operation.content}\n`;
      const block = `${open}runonroad:begin ${id}${close}\n${body}${open}runonroad:end ${id}${close}\n`;
      // top-level TOML keys go first (ADR-0119 point 3 bis): a table header above them would own them
      const topLevel = isTopLevelToml(operation.path, body);
      const next = keepFinalNewline(current?.content ?? '', (text) => {
        const span = locate(text, id, operation.path);
        if (topLevel) {
          const outside =
            span === undefined ? text : text.slice(0, span.start) + text.slice(span.end);
          const clash = tomlConflict(
            outside.replace(/# runonroad:begin [^\n]*\n[\s\S]*?# runonroad:end [^\n]*\n?/gu, ''),
            body,
          );
          if (clash !== undefined) {
            throw refused(operation.path, `already sets ${clash}; ror will not override it`);
          }
        }
        if (span !== undefined) return text.slice(0, span.start) + block + text.slice(span.end);
        return topLevel ? `${block}${text === '' ? '' : `\n${text}`}` : `${text}${block}`;
      });
      pending.set(resolved, { content: next, mode: current?.mode ?? 0o644 });
      record(state, { path: operation.path, block_id: id, sha256: digest(body) });
      return;
    }
    case 'remove_managed': {
      const { path, block_id: id } = operation;
      if (path === undefined || operation.owner !== undefined) break;
      // an id that is no block id can only name a json or a dir entry (ADR-0119 point 2)
      if (id !== undefined && !BLOCK_ID.test(id)) throw refused(id, 'is not a block id ror writes');
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
      const rest = keepFinalNewline(current.content, (text) => stripBlock(text, id, path));
      // shortcut: a file the block leaves empty is removed, even one empty before ror; record `created` in the lock if that matters.
      if (rest !== current.content) {
        pending.set(resolved, rest === '' ? null : { content: rest, mode: current.mode });
      }
      return;
    }
    case 'ensure_dir':
      if (state.options.extended === true) {
        planDir(operation.path, state);
        return;
      }
      break;
    case 'merge_json':
      if (state.options.extended === true) {
        planJson(operation, state);
        return;
      }
      break;
    default:
  }
  throw new UnsupportedOperationError(`${operation.op} is not an operation this writer executes`);
}

/** The text without block `id`; the text itself when the block is not there. */
function stripBlock(text: string, id: string, rooted: string): string {
  const span = locate(text, id, rooted);
  return span === undefined ? text : text.slice(0, span.start) + text.slice(span.end);
}

function refuseJsonDoc(state: State, resolved: string, rooted: string): void {
  if (state.docs.has(resolved)) throw refused(rooted, 'is also edited as JSON in this apply');
}

// ------------------------------------------------------------------ dir

/** `resolve`, with a path under a file refused like any other path the root cannot hold. */
function resolveHeld(rooted: string, roots: Layer['roots']): string {
  try {
    return resolve(rooted, roots);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR')
      throw refused(rooted, 'is under a file');
    throw error;
  }
}

function planDir(rooted: string, state: State): void {
  const resolved = resolveHeld(rooted, state.layer.roots);
  const match = /^(?<head>\$\{[a-z_]+\})\/(?<rel>.*)$/su.exec(rooted);
  const segments = (match?.groups?.['rel'] ?? '').split('/');
  const head = match?.groups?.['head'] ?? '';
  // from the leaf up: the folders that do not exist yet are the ones ror creates
  const missing: { resolved: string; rooted: string }[] = [];
  let walk = resolved;
  for (let depth = segments.length; depth > 0; depth -= 1) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(walk, { throwIfNoEntry: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      throw refused(rooted, 'is under a file');
    }
    if (stat === undefined)
      missing.unshift({ resolved: walk, rooted: `${head}/${segments.slice(0, depth).join('/')}` });
    else if (!stat.isDirectory()) throw refused(rooted, 'is not a folder');
    else break;
    walk = dirname(walk);
  }
  if (missing.length > 0) state.dirsToCreate.push(resolved);
  const created = new Set(missing.map((dir) => dir.rooted));
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const level = `${head}/${segments.slice(0, depth).join('/')}`;
    const owned = created.has(level) || findEntry(state.previous, level, DIR_ID) !== -1;
    if (owned) {
      record(state, { path: level, block_id: DIR_ID, kind: 'dir', sha256: digest('') });
    }
  }
}

// ----------------------------------------------------------------- json

type MergeJson = Extract<ContractOperation, { op: 'merge_json' }>;

function loadDoc(state: State, resolved: string, rooted: string): JsonDoc {
  const known = state.docs.get(resolved);
  if (known !== undefined) return known;
  if (state.pending.has(resolved)) throw refused(rooted, 'is also written as a whole file');
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  let doc: JsonDoc;
  if (stat === undefined) {
    doc = { rooted, obj: {}, before: undefined, mode: 0o644, remove: false };
  } else {
    if (!stat.isFile()) throw refused(rooted, 'is not a regular file');
    const text = fs.readFileSync(resolved, 'utf8');
    const obj = parseJsonObject(text);
    if (obj === undefined) {
      throw refused(
        rooted,
        'is not a JSON object (a file with comments is not edited), so ror will not edit it',
      );
    }
    doc = { rooted, obj, before: text, mode: stat.mode & 0o777, remove: false };
  }
  state.docs.set(resolved, doc);
  return doc;
}

const union = (...lists: (readonly string[] | undefined)[]): string[] => [
  ...new Set(lists.flatMap((list) => list ?? [])),
];

function planJson(operation: MergeJson, state: State): void {
  if (operation.strategy === 'remove') {
    throw refused(operation.path, 'uses merge_json remove, which ror does not execute');
  }
  if (!operation.path.endsWith('.json')) {
    throw refused(operation.path, 'is not a .json file, which is all merge_json edits');
  }
  try {
    segmentsOf(operation.pointer);
  } catch (error) {
    throw refused(operation.pointer, (error as PointerError).message);
  }
  const resolved = resolveHeld(operation.path, state.layer.roots);
  for (const other of state.touched) {
    const [otherPath, otherId] = other.split('#');
    if (otherPath !== operation.path || !otherId?.startsWith('json:')) continue;
    if (overlaps(otherId.slice('json:'.length), operation.pointer)) {
      throw refused(operation.pointer, 'overlaps another pointer edited in the same file');
    }
  }
  const id = jsonId(operation.pointer);
  const old = state.previous.entries.find(
    (entry) => entry.path === operation.path && entry.block_id === id,
  );
  const doc = loadDoc(state, resolved, operation.path);
  const createsFile = doc.before === undefined && doc.claimed === undefined;
  if (createsFile) doc.claimed = entryKey({ path: operation.path, block_id: id });
  const current = getAt(doc.obj, operation.pointer);
  let entry: LockEntry;

  if (operation.strategy === 'set') {
    const was = old?.strategy === 'set' ? old.values?.[0] : undefined;
    const will = old?.next?.values?.[0];
    const ours =
      old !== undefined &&
      old.strategy === 'set' &&
      (sameJson(current, was) || (will !== undefined && sameJson(current, will)));
    const hadPrevious = ours ? (old.had_previous ?? false) : current !== undefined;
    const prior = ours ? old.previous : current;
    const created = setAt(doc.obj, operation.pointer, operation.value);
    if (created === undefined) {
      throw refused(operation.pointer, `cannot be set in ${JSON.stringify(operation.path)}`);
    }
    const parents = union(ours ? old.created_parents : undefined, created);
    entry = {
      path: operation.path,
      block_id: id,
      kind: 'json',
      pointer: operation.pointer,
      strategy: 'set',
      sha256: digest(JSON.stringify([operation.value])),
      values: [operation.value],
      had_previous: hadPrevious,
      ...(hadPrevious ? { previous: prior } : {}),
      ...(createsFile || (ours && old.created_file === true) ? { created_file: true } : {}),
      ...(parents.length > 0 ? { created_parents: parents } : {}),
    };
  } else {
    const elements = Array.isArray(operation.value)
      ? (operation.value as unknown[])
      : [operation.value];
    if (current !== undefined && !Array.isArray(current)) {
      throw refused(operation.pointer, 'holds something that is not a list');
    }
    // what ror put there before, and an interrupted apply may have put there since
    const ownedBefore = [...(old?.values ?? []), ...(old?.next?.values ?? [])];
    const outdated = (old?.values ?? []).filter(
      (value) => !elements.some((element) => sameJson(element, value)),
    );
    let list = (Array.isArray(current) ? [...(current as unknown[])] : []).filter(
      (item) => !outdated.some((value) => sameJson(value, item)),
    );
    const added: unknown[] = [];
    for (const element of elements) {
      if (list.some((item) => sameJson(item, element))) continue;
      list = [...list, element];
      added.push(element);
    }
    // elements that were already there before ror are the owner's own, never ror's to remove
    const kept = ownedBefore.filter(
      (value, index) =>
        ownedBefore.findIndex((other) => sameJson(other, value)) === index &&
        elements.some((element) => sameJson(element, value)) &&
        Array.isArray(current) &&
        (current as unknown[]).some((item) => sameJson(item, value)),
    );
    const created = setAt(doc.obj, operation.pointer, list);
    if (created === undefined) {
      throw refused(operation.pointer, `cannot be set in ${JSON.stringify(operation.path)}`);
    }
    const values = [...kept, ...added];
    const parents = union(old?.created_parents, created);
    entry = {
      path: operation.path,
      block_id: id,
      kind: 'json',
      pointer: operation.pointer,
      strategy: 'append_unique',
      sha256: digest(JSON.stringify(values)),
      values,
      ...(createsFile || old?.created_file === true ? { created_file: true } : {}),
      ...(current === undefined || old?.created_array === true ? { created_array: true } : {}),
      ...(parents.length > 0 ? { created_parents: parents } : {}),
    };
  }
  record(state, entry);
}

/** Renders each edited JSON file into the pending writes, or removes a file `ror` created and emptied. */
function renderDocs(state: State): void {
  for (const [resolved, doc] of state.docs) {
    if (doc.remove || (Object.keys(doc.obj).length === 0 && doc.before === undefined)) {
      state.pending.set(resolved, null);
    } else {
      state.pending.set(resolved, {
        content: `${JSON.stringify(doc.obj, null, 2)}\n`,
        mode: doc.mode,
      });
    }
  }
}

// --------------------------------------------------------------- retire

/** Everything an earlier apply wrote and this one does not produce: retired if unchanged, else kept. */
function retireStale(state: State): void {
  const stale = state.previous.entries.filter((entry) => !state.touched.has(entryKey(entry)));
  const dirs = stale.filter((entry) => entry.kind === 'dir');
  for (const entry of stale.filter((item) => item.kind !== 'dir')) retireOne(entry, state);
  // the deepest folders first, and only when nothing is left in them
  for (const entry of dirs.sort((a, b) => b.path.length - a.path.length)) retireDir(entry, state);
  // the objects `ror` created in a JSON file go when nothing is left in them; while an entry of the file
  // stays, it inherits the ones still in use (two entries often share the parent one of them created)
  for (const [resolved, pointers] of state.createdParents) {
    const doc = state.docs.get(resolved);
    if (doc === undefined) continue;
    const leftover: string[] = [];
    for (const pointer of [...pointers].sort((a, b) => b.length - a.length)) {
      const here = getAt(doc.obj, pointer);
      if (isObject(here) && Object.keys(here).length === 0) {
        const parts = segmentsOf(pointer);
        deleteAt(doc.obj, `/${[...parts.slice(0, -1), parts.at(-1) ?? ''].join('/')}`, []);
      } else if (isObject(here)) leftover.push(pointer);
    }
    const index = state.lock.entries.findIndex(
      (item) => item.kind === 'json' && item.path === doc.rooted,
    );
    const taker = state.lock.entries[index];
    if (taker !== undefined && leftover.length > 0) {
      state.lock.entries[index] = {
        ...taker,
        created_parents: [...new Set([...(taker.created_parents ?? []), ...leftover])],
      };
    }
  }
  // a file `ror` created goes with its last entry; while another entry of it stays, that one inherits the fact
  for (const resolved of state.createdFiles) {
    const doc = state.docs.get(resolved);
    const left = state.lock.entries.findIndex(
      (item) => item.kind === 'json' && state.docs.get(resolved)?.rooted === item.path,
    );
    if (left !== -1) {
      const taker = state.lock.entries[left] as LockEntry;
      state.lock.entries[left] = { ...taker, created_file: true };
    } else if (doc !== undefined && Object.keys(doc.obj).length === 0) doc.remove = true;
  }
}

function drop(state: State, entry: LockEntry): void {
  const index = findEntry(state.lock, entry.path, entry.block_id);
  if (index !== -1) state.lock.entries.splice(index, 1);
  state.removed.push(entry.path);
}

function keep(state: State, entry: LockEntry): void {
  state.kept.push(entry.path);
}

function retireOne(entry: LockEntry, state: State): void {
  let resolved: string;
  try {
    resolved = resolve(entry.path, state.layer.roots, false);
  } catch {
    keep(state, entry);
    return;
  }
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat === undefined) {
    drop(state, entry);
    return;
  }
  if (entry.kind === 'json') {
    retireJson(entry, resolved, state);
    return;
  }
  if (!stat.isFile()) {
    keep(state, entry);
    return;
  }
  const text = read(resolved, entry.path, state.pending)?.content ?? '';
  if (entry.block_id === undefined) {
    if (digest(text) !== entry.sha256) {
      keep(state, entry);
      return;
    }
    state.pending.set(resolved, null);
    drop(state, entry);
    return;
  }
  const body = blockBody(text, entry.block_id, entry.path);
  if (body === undefined) {
    drop(state, entry);
    return;
  }
  if (digest(body) !== entry.sha256) {
    keep(state, entry);
    return;
  }
  const rest = keepFinalNewline(text, (current) =>
    stripBlock(current, entry.block_id ?? '', entry.path),
  );
  state.pending.set(resolved, rest === '' ? null : { content: rest, mode: stat.mode & 0o777 });
  drop(state, entry);
}

function retireJson(entry: LockEntry, resolved: string, state: State): void {
  if (entry.pointer === undefined) {
    drop(state, entry);
    return;
  }
  let doc: JsonDoc;
  try {
    doc = loadDoc(state, resolved, entry.path);
  } catch (error) {
    if (error instanceof RefusedOperationError) {
      keep(state, entry);
      return;
    }
    throw error;
  }
  const current = getAt(doc.obj, entry.pointer);
  const parents = entry.created_parents ?? [];
  if (entry.strategy === 'set') {
    if (sameJson(current, entry.values?.[0])) {
      if (entry.had_previous === true) setAt(doc.obj, entry.pointer, entry.previous);
      else deleteAt(doc.obj, entry.pointer, parents);
    } else if (
      !(entry.had_previous === true ? sameJson(current, entry.previous) : current === undefined)
    ) {
      // changed by a person since: still owned, never destroyed
      keep(state, entry);
      return;
    }
  } else if (Array.isArray(current)) {
    const values = entry.values ?? [];
    const remaining = current.filter((item) => !values.some((value) => sameJson(value, item)));
    if (remaining.length > 0) setAt(doc.obj, entry.pointer, remaining);
    else if (entry.created_array === true) deleteAt(doc.obj, entry.pointer, parents);
    else setAt(doc.obj, entry.pointer, []);
  }
  drop(state, entry);
  if (entry.created_file === true) state.createdFiles.add(resolved);
  if (parents.length > 0) {
    state.createdParents.set(
      resolved,
      new Set([...(state.createdParents.get(resolved) ?? []), ...parents]),
    );
  }
}

function retireDir(entry: LockEntry, state: State): void {
  let resolved: string;
  try {
    resolved = resolve(entry.path, state.layer.roots, false);
  } catch {
    keep(state, entry);
    return;
  }
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat === undefined) {
    drop(state, entry);
    return;
  }
  if (!stat.isDirectory()) {
    keep(state, entry);
    return;
  }
  const leaving = new Set([
    ...state.dirsToRemove.map((dir) => dir.resolved),
    ...[...state.pending].filter(([, file]) => file === null).map(([path]) => path),
  ]);
  if (fs.readdirSync(resolved).some((name) => !leaving.has(join(resolved, name)))) {
    keep(state, entry);
    return;
  }
  state.dirsToRemove.push({ resolved, rooted: entry.path });
  drop(state, entry);
}

/**
 * The lock before the first write, when an apply puts a json edit in place (ADR-0119 point 6): the
 * previous entries as they were, and the new ones next to them, so an interrupted apply still knows
 * what was there before and what it must take back. `undefined` when no json entry is new or changed.
 */
function intentLock(state: State): Lock | undefined {
  const fresh = state.lock.entries.filter(
    (entry) =>
      entry.kind === 'json' &&
      !sameJson(
        state.previous.entries.find((old) => entryKey(old) === entryKey(entry)),
        entry,
      ),
  );
  if (fresh.length === 0) return undefined;
  const entries = state.previous.entries.map((entry) => ({ ...entry }));
  for (const entry of fresh) {
    const index = entries.findIndex((old) => entryKey(old) === entryKey(entry));
    const undo = Object.fromEntries(
      UNDO_KEYS.filter((key) => key in entry).map((key) => [key, entry[key]]),
    );
    if (index === -1) entries.push({ ...entry, pending: true });
    else entries[index] = { ...(entries[index] as LockEntry), next: undo };
  }
  return { ...state.previous, entries };
}

const findEntry = (lock: Lock, path: string, blockId?: string) =>
  lock.entries.findIndex((entry) => entry.path === path && entry.block_id === blockId);

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
