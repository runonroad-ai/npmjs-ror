// The `~/.runonroad` state (SPEC-007 §4): with the managed writer, the only module that writes
// files. Never a token: the token lives in the OS keychain (ADR-0084 §2).
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { SigningKey } from '@runonroad/api-contract';
import { clientEnvironment } from '@runonroad/config/client';
import { parse, stringify } from 'yaml';

import { flagValue } from './flags.js';
import { RorError } from './ror-error.js';

/** `~/.runonroad/config.yaml`: where the installation is, and which organization. No secret. */
export interface RorConfig {
  server?: string;
  organization?: string;
  /** The device `ror login` enrolled on `server`: what `ror logout` revokes. */
  device?: string;
}

/** `~/.runonroad/signing-keys.json`: the keys every bundle is verified with (ADR-0011). */
export interface PinnedKeys {
  organization_id: string;
  keys: readonly SigningKey[];
}

/**
 * Where the enrolment lives: RUNONROAD_HOME when it is set, which is where the hook and `ror status`
 * look for the pinned keys (`rorHome()`), else `<home>/.runonroad`. Two places for one file would leave
 * a hook that cannot see the enrolment `ror login` just wrote.
 */
const stateDir = (home: string) => clientEnvironment().rorHome ?? join(home, '.runonroad');

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, content, { mode: 0o644 });
  renameSync(temporary, path);
}

/** The config, or `{}` when `ror login` has never run. ROR-E119 when the file is not a YAML mapping. */
export function readConfig(home: string): RorConfig {
  const path = join(stateDir(home), 'config.yaml');
  if (!existsSync(path)) return {};
  const unreadable = (reason: string) =>
    new RorError('ROR-E119', `${path} cannot be read (${reason}). Fix or delete it, then retry.`);
  let config: unknown;
  try {
    config = parse(readFileSync(path, 'utf8')) ?? {};
  } catch (error) {
    throw unreadable(
      error instanceof Error ? (error.message.split('\n')[0] ?? 'unparsable') : 'unparsable',
    );
  }
  if (typeof config !== 'object' || Array.isArray(config)) throw unreadable('not a mapping');
  return config as RorConfig;
}

/** The origin fixed at build time: what `ror` talks to when no server was ever chosen. */
// shortcut: the dev stack API during the MVP (Lead, 2026-10-23), until the SaaS origin is decided.
export const DEFAULT_SERVER = 'http://localhost:3000';

/** The server of a verb, in one place: `--server`, then `config.yaml`, then the build-time origin. */
export function resolveServer(args: readonly string[], home: string): string {
  // Read before the flag: a broken config.yaml fails before any request, not after enrolment.
  const { server } = readConfig(home);
  return flagValue(args, '--server') ?? server ?? DEFAULT_SERVER;
}

/** Records the server and organization, keeping any other key already in the file. */
export function writeLogin(home: string, config: Required<RorConfig>, pinned: PinnedKeys): void {
  mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  writeAtomic(join(stateDir(home), 'config.yaml'), stringify({ ...readConfig(home), ...config }));
  writeAtomic(join(stateDir(home), 'signing-keys.json'), `${JSON.stringify(pinned, null, 2)}\n`);
}

// ------------------------------------------------------------------ the state directory

/**
 * Every other module that keeps something of its own under `~/.runonroad` (challenges, health log,
 * caches, locks) goes through the functions below, never through `node:fs` (ADR-0007): a path is
 * given as the root of the state directory and a relative path, and one that leaves the root is refused.
 */
function inside(root: string, rel: string): string {
  const path = join(root, rel);
  const from = relative(root, path);
  if (from === '' || from.startsWith('..') || isAbsolute(from)) {
    throw new Error(`${rel} leaves the state directory`);
  }
  return path;
}

/** Creates a folder (and its parents) of the state directory. */
export function ensureStateDir(root: string, rel: string, mode = 0o700): void {
  mkdirSync(inside(root, rel), { recursive: true, mode });
}

/** Writes a file of the state directory whole and renames it into place: nobody reads half of it. */
export function writeStateFile(root: string, rel: string, data: string, mode = 0o600): void {
  const path = inside(root, rel);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, data, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

/** Appends to a file of the state directory (created with `mode`). */
export function appendStateFile(root: string, rel: string, data: string, mode = 0o600): void {
  const path = inside(root, rel);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, data, { mode });
}

/** Removes a file or a folder of the state directory; nothing is an error. */
export function removeState(root: string, rel: string): void {
  rmSync(inside(root, rel), { recursive: true, force: true });
}

/** Takes a lock folder of the state directory: false when it already exists. */
export function takeStateLock(root: string, rel: string): boolean {
  const path = inside(root, rel);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the machine's files of `ror`

/** Where `ror` keeps its own files: RUNONROAD_HOME, else `~/.runonroad`. */
export const rorHome = (): string => clientEnvironment().rorHome ?? join(homedir(), '.runonroad');

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The keys pinned at `ror login`, or none when this machine never logged in. */
export function readPinnedKeys(home: string): PinnedKeys | undefined {
  const parsed = readJson(join(stateDir(home), 'signing-keys.json')) as PinnedKeys | undefined;
  return parsed !== undefined && Array.isArray(parsed.keys) ? parsed : undefined;
}

/** Writes inside `rorHome()`, whole and renamed into place; Windows retries a rename another process blocks. */
function writeAtomicHome(path: string, data: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.ror-tmp-${String(process.pid)}`;
  writeFileSync(temporary, data, { mode });
  // POSIX modes mean nothing on Windows (the user profile's ACL applies)
  if (platform() !== 'win32') chmodSync(temporary, mode);
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (platform() !== 'win32') throw error;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(path, { force: true });
        renameSync(temporary, path);
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
      }
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

// ------------------------------------------------------------------ cache

/** The last verified bundle of a project and target. */
export interface CacheEntry {
  readonly etag: string;
  readonly body: string;
  readonly signature: string;
  readonly saved_at: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each) => typeof each === 'string');

/**
 * The physical path of a project, so that every spelling of it gives one key: `git rev-parse --show-toplevel`
 * answers `/private/var/...` on macOS where the caller held `/var/...`, and `C:/Users/...` on Windows
 * where `resolve` answers `C:\Users\...` (or the 8.3 short name of the temp folder).
 */
const physical = (projectDir: string): string => {
  try {
    return realpathSync.native(projectDir);
  } catch {
    return resolve(projectDir);
  }
};

export const projectKey = (projectDir: string): string =>
  createHash('sha256').update(physical(projectDir)).digest('hex').slice(0, 16);

/** One cache per project and target; Claude Code keeps its original name. */
const cachePath = (projectDir: string, target: string): string =>
  join(
    rorHome(),
    'cache',
    `${projectKey(projectDir)}${target === 'claude_code' ? '' : `.${target}`}.json`,
  );

export function saveCache(projectDir: string, entry: CacheEntry, target = 'claude_code'): void {
  writeAtomicHome(cachePath(projectDir, target), JSON.stringify(entry), 0o600);
}

export function loadCache(projectDir: string, target = 'claude_code'): CacheEntry | undefined {
  const read = readJson(cachePath(projectDir, target));
  if (!isRecord(read)) return undefined;
  const { etag, body, signature, saved_at: savedAt } = read;
  return typeof etag === 'string' &&
    typeof body === 'string' &&
    typeof signature === 'string' &&
    typeof savedAt === 'string'
    ? { etag, body, signature, saved_at: savedAt }
    : undefined;
}

// ------------------------------------------------------------------ state

export interface State {
  /** The latest time ever seen: expiry never trusts a clock set back. */
  last_seen_ms: number;
  projects: string[];
  /** The person or agent each project's policy was first activated for (ADR-0114). */
  principals: Record<string, string>;
  /** The tools each project is governed for: what the hooks of Codex and Cursor trust to know a project is governed (ADR-0115). */
  targets: Record<string, string[]>;
}

const statePath = (): string => join(rorHome(), 'state.json');

export function loadState(): State {
  const read = readJson(statePath());
  const empty: State = { last_seen_ms: 0, projects: [], principals: {}, targets: {} };
  if (!isRecord(read) || typeof read['last_seen_ms'] !== 'number' || !isStrings(read['projects'])) {
    return empty;
  }
  const principals = read['principals'] ?? {};
  const targets = read['targets'] ?? {};
  if (
    !isRecord(principals) ||
    Object.values(principals).some((each) => typeof each !== 'string') ||
    !isRecord(targets) ||
    Object.values(targets).some((each) => !isStrings(each))
  ) {
    return empty;
  }
  return {
    last_seen_ms: read['last_seen_ms'],
    projects: read['projects'],
    principals: principals as Record<string, string>,
    targets: targets as Record<string, string[]>,
  };
}

export function saveState(state: State): void {
  writeAtomicHome(statePath(), JSON.stringify(state), 0o600);
}

// ------------------------------------------------------------ machine lock

export class BusyError extends Error {
  override readonly name = 'BusyError';
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A holder is gone when its process is, or when it has run for longer than any sync could (a hung one). */
const HUNG_MS = 6 * 60 * 60 * 1000;

interface LockOwner {
  readonly pid: number;
  readonly at: number;
  readonly token: string;
}

function ownerOf(directory: string): LockOwner | undefined {
  const record = readJson(join(directory, 'pid')) as Partial<LockOwner> | undefined;
  // a lock written before tokens existed has none: still a holder, judged by its process
  return record?.pid === undefined || record.at === undefined
    ? undefined
    : { pid: record.pid, at: record.at, token: record.token ?? '' };
}

/**
 * The lock is a directory that appears already holding its owner: made aside, then renamed into
 * place, which fails while a lock exists, so no process ever sees a lock without an owner.
 * A holder is replaced only when its process is gone (or hung for hours); the stale directory is
 * first renamed away, an action only one contender can win, and only if it is still the holder
 * that was judged stale. Release removes the lock only when it is still ours.
 */
function acquireMachineLock(): { directory: string; token: string } {
  const directory = join(rorHome(), 'sync.lock');
  mkdirSync(rorHome(), { recursive: true, mode: 0o700 });
  const token = randomBytes(12).toString('hex');
  for (let attempt = 0; ; attempt += 1) {
    const staging = `${directory}.${token}.${String(attempt)}`;
    mkdirSync(staging);
    writeFileSync(
      join(staging, 'pid'),
      JSON.stringify({ pid: process.pid, at: Date.now(), token } satisfies LockOwner),
    );
    try {
      renameSync(staging, directory);
      return { directory, token };
    } catch {
      rmSync(staging, { recursive: true, force: true });
      const holder = ownerOf(directory);
      const stale =
        holder === undefined
          ? !existsSync(directory) || attempt > 0
          : !processAlive(holder.pid) || Date.now() - holder.at > HUNG_MS;
      if (!stale || attempt > 2) throw new BusyError('another ror sync is running');
      // judged stale: take it away by name, but only while it is still the holder we judged
      if (holder !== undefined && ownerOf(directory)?.token === holder.token) {
        try {
          renameSync(directory, `${directory}.stale.${token}.${String(attempt)}`);
        } catch {
          // another contender won; try to acquire again
        }
        rmSync(`${directory}.stale.${token}.${String(attempt)}`, { recursive: true, force: true });
      }
    }
  }
}

function releaseMachineLock(held: { directory: string; token: string }): void {
  // never remove a successor's lock: only ours, by the token we wrote
  if (ownerOf(held.directory)?.token !== held.token) return;
  const aside = `${held.directory}.released.${held.token}`;
  try {
    renameSync(held.directory, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

/** One writer at a time on the machine. */
export function withMachineLock<T>(work: () => T): T {
  const held = acquireMachineLock();
  try {
    return work();
  } finally {
    releaseMachineLock(held);
  }
}

/** The same lock around work that waits (a tool's app server answering). */
export async function withMachineLockAsync<T>(work: () => Promise<T>): Promise<T> {
  const held = acquireMachineLock();
  try {
    return await work();
  } finally {
    releaseMachineLock(held);
  }
}

// ------------------------------------------------------------------ files a hook may write

const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const NONBLOCK = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;

/**
 * `openSync` that refuses a link at the leaf. POSIX does it with O_NOFOLLOW; Windows has no such flag
 * (it is 0 there), so the leaf is looked at first.
 * Best effort, not isolation from someone who can write in the directory: between the look and the open a swap is possible on
 * Windows. These files hold health state and logs, under the person's own profile. shortcut: upgrade when libuv gets a no-follow open.
 */
function openLeaf(path: string, flags: number, mode?: number): number {
  if (NOFOLLOW === 0) {
    let isLink = false;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch (error) {
      // it does not exist yet: nothing to follow; any other failure is not "absent"
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (isLink) throw Object.assign(new Error('a link where the file goes'), { code: 'ELOOP' });
  }
  return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
}

/**
 * Reads a file the way the hook writes it: through a descriptor opened without following a link and
 * without waiting (a pipe planted at its place is refused, never blocked on), only if it is a regular
 * file, and no more than `limit` bytes. `size` is the whole file's size, which may exceed what was read.
 */
export function readSafe(path: string, limit: number): { text: Buffer; size: number } | undefined {
  let fd: number | undefined;
  try {
    fd = openLeaf(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const got = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, got), size: stat.size };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Appends ONE line to a private file of the state directory, opened without following a link and without
 * waiting: no read, no rewrite, no lock. It writes nothing when the file would pass `maxBytes` or is not a
 * regular file. Any failure is a lost line, never an error for the hook (ADR-0008).
 */
export function appendLineGuarded(root: string, rel: string, line: string, maxBytes: number): void {
  try {
    const path = inside(root, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openLeaf(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW | NONBLOCK,
      0o600,
    );
    try {
      // a pipe or a device planted at the file's place is not ours to write: refused, never waited on
      if (!fstatSync(fd).isFile()) return;
      if (fstatSync(fd).size + line.length > maxBytes) return;
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {
    // lost, by design
  }
}

/**
 * Appends lines within the same bound: what does not fit is lost and replaced by `marker` (written at most
 * once, its room always kept back), so a repeated crash cannot grow the file.
 */
export function appendBoundedLines(
  root: string,
  rel: string,
  lines: readonly string[],
  maxBytes: number,
  marker: string,
): void {
  const path = inside(root, rel);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openLeaf(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW | NONBLOCK,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return;
    let size = stat.size;
    const limit = maxBytes - marker.length;
    for (const line of lines) {
      if (size + line.length + 1 > limit) {
        if (size + marker.length <= maxBytes && !endsWith(path, size, marker))
          writeSync(fd, marker);
        return;
      }
      writeSync(fd, `${line}\n`);
      size += line.length + 1;
    }
  } finally {
    closeSync(fd);
  }
}

/** Whether the file already ends with `marker`: a repeated interrupted requeue adds none. */
function endsWith(path: string, size: number, marker: string): boolean {
  if (size < marker.length) return false;
  let fd: number | undefined;
  try {
    fd = openLeaf(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const tail = Buffer.alloc(marker.length);
    readSync(fd, tail, 0, marker.length, size - marker.length);
    return tail.toString('utf8') === marker;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Replaces a file of the state directory by a unique name opened exclusively and without following a link,
 * then renamed over it. Writes run under the machine lock, so a temporary copy left by a killed write is
 * an orphan: it is reclaimed first.
 */
export function replaceStateFile(root: string, rel: string, data: string): void {
  const path = inside(root, rel);
  const folder = dirname(path);
  const name = path.slice(folder.length + 1);
  try {
    for (const each of readdirSync(folder)) {
      if (each.startsWith(`${name}.`) && each.endsWith('.tmp')) {
        rmSync(join(folder, each), { force: true });
      }
    }
  } catch {
    // nothing to reclaim
  }
  const temporary = join(folder, `${name}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK,
    0o600,
  );
  try {
    writeSync(fd, data);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, path);
}

/** Moves a file of the state directory to another name of it. */
export function renameState(root: string, from: string, to: string): void {
  renameSync(inside(root, from), inside(root, to));
}
