/**
 * The person's skill library on this device (ADR-0096 decision 11, ADR-0095, SPEC-018), on staging's
 * managed writer (ADR-0007, ADR-0119).
 *
 * `ror sync` makes the folders `ror-lib-<slug>` of the tool's skills directory match the signed
 * library the server holds, in both directions:
 *
 *   1. UP: a folder edited in place (or created by `ror skills new`) is validated locally (tree rules,
 *      the validation profile, the secret scan) and sent as a new revision from the revision this
 *      device knows. A stale base (409) or a tree that is refused never overwrites the person's work:
 *      a copy is kept OUTSIDE discovery, in `<ror home>/library/`, and the person is told where.
 *   2. DOWN: the signed library is verified against the keys pinned at login, then each exposed skill
 *      is written file by file by the managed writer (one `write_file` per file, recorded in the
 *      library lock); what the server no longer produces is retired only if it is still what `ror`
 *      wrote. A file a person edited stays, and its copy is kept aside first.
 *
 * Nothing is written outside the managed writer and the state directory (the `fs-writers` guard), so:
 *   - a folder that `ror` did not write is never overwritten (a different copy is kept aside, the folder
 *     stays as it is: shortcut, adopting a hand-made folder needs an `adopt` operation, ADR-0119);
 *   - a refused or conflicting folder stays in discovery with the person's text until the server's
 *     version overwrites the files `ror` wrote (before, the folder left discovery: not possible without
 *     deleting content `ror` does not own).
 *
 * Local state lives in `<ror home>/library/`: `lock.json` (what was written, by id), `managed-lock.json`
 * (the managed writer's lock), `base/<id>/` (the server's exposed revision, for `ror skills diff`),
 * `work/<slug>/` (a working copy being edited outside discovery), `conflicts/` and `quarantine/`.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import type { ContractOperation, LibraryDocument } from '@runonroad/api-contract';
import { LibraryDocumentSchema, SIGNATURE_HEADER } from '@runonroad/api-contract/harness';
import { clientEnvironment } from '@runonroad/config/client';
import {
  LIBRARY_FOLDER_PREFIX,
  MAX_FILES,
  MAX_TREE_BYTES,
  checkTree,
  folderOf,
  isSlug,
  profileFindings,
  secretFindings,
  slugOf,
  treeDigest,
  type Finding,
  type SkillFileInput,
} from '@runonroad/skills';

import { applyManaged, readLock, RefusedOperationError, type Layer } from './managed.js';
import { defaultHome } from './paths.js';
import { call, clientOf, pinnedKeys, type Enrolment } from './session.js';
import { readJson, removeState, rorHome, writeStateFile } from './state.js';
import { SignatureError, verifyBody } from './verify.js';

export interface LibraryEnv {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  /** The skills directory a tool discovers (default: Claude Code's `~/.claude/skills`). */
  readonly skillsRoot?: string;
}

export interface LibraryOutcome {
  readonly code: 0 | 11 | 30 | 31 | 32;
  readonly lines: readonly string[];
}

const SKILLS_FOLDER = /^ror-lib-[a-z0-9][a-z0-9-]{0,47}$/u;
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|.*~|.*\.sw[a-p]|\.#.*)$/u;

export function skillsRootOf(env: Pick<LibraryEnv, 'skillsRoot'>): string {
  if (env.skillsRoot !== undefined) return env.skillsRoot;
  const claude = clientEnvironment().claudeConfigDir ?? join(defaultHome(), '.claude');
  return join(claude, 'skills');
}

// ------------------------------------------------------------------ local state

interface LockEntry {
  readonly folder: string;
  readonly slug: string;
  /** The revision this device last received or sent: the base of the next save. */
  readonly revision: number;
  /** The digest of what ror last wrote (or what the server accepted) at the folder. */
  readonly exposed_digest: string;
  /** False for a folder `ror` did not write: it is never written into (see the header). */
  readonly managed?: boolean;
}
export interface LibraryLock {
  version: 1;
  member_id: string | null;
  last_issued_at: string | null;
  etag: string | null;
  skills: Record<string, LockEntry>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isEntry = (value: unknown): value is LockEntry =>
  isRecord(value) &&
  typeof value['folder'] === 'string' &&
  typeof value['slug'] === 'string' &&
  Number.isInteger(value['revision']) &&
  typeof value['exposed_digest'] === 'string' &&
  (value['managed'] === undefined || typeof value['managed'] === 'boolean');
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const LOCK = 'library/lock.json';
const baseRel = (id: string): string => `library/base/${id}`;
const workRel = (slug: string): string => `library/work/${slug}`;
export const baseDirOf = (id: string): string => join(rorHome(), baseRel(id));
export const workDirOf = (slug: string): string => join(rorHome(), workRel(slug));

export function loadLock(): LibraryLock {
  const raw = readJson(join(rorHome(), LOCK));
  if (
    isRecord(raw) &&
    raw['version'] === 1 &&
    nullableString(raw['member_id']) &&
    nullableString(raw['last_issued_at']) &&
    nullableString(raw['etag']) &&
    isRecord(raw['skills']) &&
    Object.values(raw['skills']).every(isEntry)
  ) {
    return {
      version: 1,
      member_id: raw['member_id'],
      last_issued_at: raw['last_issued_at'],
      etag: raw['etag'],
      skills: raw['skills'] as Record<string, LockEntry>,
    };
  }
  return { version: 1, member_id: null, last_issued_at: null, etag: null, skills: {} };
}

function forget(lock: LibraryLock, id: string): void {
  lock.skills = Object.fromEntries(Object.entries(lock.skills).filter(([key]) => key !== id));
}

function saveLock(lock: LibraryLock): void {
  writeStateFile(rorHome(), LOCK, JSON.stringify(lock), 0o600);
}

/** The managed writer's view of the skills directory: its own lock, so `ror sync`'s lock is untouched. */
function layerOf(env: Pick<LibraryEnv, 'skillsRoot'>): Layer {
  const skills = skillsRootOf(env);
  return {
    // the parent too: the writer never creates a root, and the skills folder itself is missing on a
    // machine where no skill was ever put there (`~/.claude` exists once Claude Code is installed)
    roots: { skills, skills_parent: dirname(skills) },
    lockPath: join(rorHome(), 'library', 'managed-lock.json'),
  };
}

/**
 * The skills folder itself, through its parent (which must exist: no tool, no folder). Always among the
 * operations, so a folder `ror` made stays recorded as its own, and one that was already there is not.
 */
const rootOp = (env: Pick<LibraryEnv, 'skillsRoot'>): ContractOperation => ({
  op: 'ensure_dir',
  path: `\${skills_parent}/${basename(skillsRootOf(env))}`,
});

const rootedFile = (folder: string, path: string): string => `\${skills}/${folder}/${path}`;

/** The folder and its sub-folders (`ensure_dir`, so a retire can take them back empty), then each file. */
const writeOps = (folder: string, files: readonly SkillFileInput[]): ContractOperation[] => {
  const dirs = new Set<string>(['']);
  for (const file of files) {
    const parts = file.path.split('/').slice(0, -1);
    for (let index = 1; index <= parts.length; index += 1)
      dirs.add(parts.slice(0, index).join('/'));
  }
  return [
    ...[...dirs]
      .sort((left, right) => left.length - right.length)
      .map((dir): ContractOperation => ({
        op: 'ensure_dir',
        path: dir === '' ? `\${skills}/${folder}` : rootedFile(folder, dir),
      })),
    ...files.map((file): ContractOperation => ({
      op: 'write_file',
      path: rootedFile(folder, file.path),
      content: file.content,
    })),
  ];
};

// ------------------------------------------------------------------ trees on disk

export interface ReadTree {
  readonly files: SkillFileInput[];
  /** Why the folder cannot be treated as a skill tree at all (a link, too big, not a folder). */
  readonly problems: Finding[];
}

/** The text files under `dir`, relative and `/`-separated; links and special files are findings, not reads. */
export function readTree(dir: string): ReadTree {
  const files: SkillFileInput[] = [];
  const problems: Finding[] = [];
  let total = 0;
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (JUNK.test(name)) continue;
      const full = join(current, name);
      const path = relative(dir, full).split(sep).join('/');
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        problems.push({ code: 'path_invalid', file: path });
      } else if (stat.isDirectory()) {
        walk(full);
      } else {
        total += stat.size;
        if (files.length >= MAX_FILES || total > MAX_TREE_BYTES) {
          if (!problems.some((each) => each.code === 'tree_too_large'))
            problems.push({ code: 'tree_too_large' });
          continue;
        }
        files.push({ path, content: readFileSync(full, 'utf8') });
      }
    }
  };
  try {
    if (!lstatSync(dir).isDirectory()) return { files, problems: [{ code: 'path_invalid' }] };
    walk(dir);
  } catch {
    problems.push({ code: 'path_invalid' });
  }
  return { files, problems };
}

/** What the local rules say of a tree: the same rules the server applies, so it is refused here first. */
export function localFindings(tree: ReadTree): Finding[] {
  return [
    ...tree.problems,
    ...checkTree(tree.files),
    ...secretFindings(tree.files),
    ...profileFindings(tree.files),
  ];
}

function writeTreeState(rel: string, files: readonly SkillFileInput[]): void {
  for (const file of files) writeStateFile(rorHome(), `${rel}/${file.path}`, file.content, 0o644);
}

let kept = 0;
/** A name that cannot collide, even for two copies set aside in the same run. */
const stampOf = (now: Date): string =>
  `${now.toISOString().replace(/[:.]/gu, '-')}-${String((kept += 1))}`;

/** Set a copy aside, outside discovery, with a name that cannot collide. */
function keep(
  kind: 'conflicts' | 'quarantine',
  slug: string,
  files: readonly SkillFileInput[],
  now: Date,
): string {
  const rel = `library/${kind}/${slug}-${stampOf(now)}`;
  writeTreeState(rel, files);
  return join(rorHome(), rel);
}

// ------------------------------------------------------------------ the server

interface Saved {
  readonly id: string;
  readonly slug: string;
  readonly current_revision: number;
}
function savedOf(text: string): Saved {
  const body: unknown = JSON.parse(text);
  if (
    !isRecord(body) ||
    typeof body['id'] !== 'string' ||
    typeof body['slug'] !== 'string' ||
    !Number.isInteger(body['current_revision'])
  )
    throw new Error('the server answered something that is not a saved skill');
  return {
    id: body['id'],
    slug: body['slug'],
    current_revision: body['current_revision'] as number,
  };
}

const frontmatterName = (files: readonly SkillFileInput[]): string | undefined => {
  const text = files.find((file) => file.path === 'SKILL.md')?.content ?? '';
  return /^---\r?\n(?:[\s\S]*?\r?\n)?name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*\r?\n/u
    .exec(text)?.[1]
    ?.trim();
};

// ------------------------------------------------------------------ the sync

export async function syncLibrary(env: LibraryEnv, enrolment: Enrolment): Promise<LibraryOutcome> {
  const client = clientOf(enrolment, env.fetch);
  const lines: string[] = [];
  const now = env.now();
  const root = skillsRootOf(env);
  const layer = layerOf(env);
  const lock = loadLock();
  let code: LibraryOutcome['code'] = 0;
  // a folder whose text was kept aside below must come back from the server whole: never a 304 then
  let setAside = false;
  const worse = (next: LibraryOutcome['code']): void => {
    if (next > code) code = next;
  };
  const managedPaths = new Set(readLock(layer.lockPath).entries.map((entry) => entry.path));
  const isManaged = (folder: string): boolean =>
    [...managedPaths].some((path) => path.startsWith(`\${skills}/${folder}/`));

  // 1. UP: what was edited or created since ror last wrote
  const known = new Map(
    Object.entries(lock.skills).map(([id, entry]) => [entry.folder, { id, entry }]),
  );
  const folders = existsSync(root)
    ? readdirSync(root).filter(
        (name) => name.startsWith(LIBRARY_FOLDER_PREFIX) && SKILLS_FOLDER.test(name),
      )
    : [];
  for (const name of folders) {
    const dir = join(root, name);
    const tree = readTree(dir);
    const digest = treeDigest(tree.files);
    const entry = known.get(name);
    if (entry !== undefined && digest === entry.entry.exposed_digest && tree.problems.length === 0)
      continue;
    const slug = name.slice(LIBRARY_FOLDER_PREFIX.length);
    const findings = localFindings(tree);
    if (findings.length > 0) {
      // not sent, not lost: a copy is kept outside discovery; the server's copy (if any) comes back below
      const where = keep('quarantine', slug, tree.files, now);
      setAside = true;
      if (entry !== undefined) forget(lock, entry.id);
      lines.push(
        `${name}: not sent (${[...new Set(findings.map((each) => each.code))].join(', ')}); your copy is kept in ${where}`,
      );
      worse(30);
      continue;
    }
    try {
      const answered =
        entry === undefined
          ? await call(client, 'POST', '/library/skills', {
              body: { name: frontmatterName(tree.files) ?? slug, files: tree.files },
            })
          : await call(client, 'PUT', `/library/skills/${entry.id}`, {
              body: { base_revision: entry.entry.revision, files: tree.files },
            });
      if (answered.status === 401)
        return {
          code: 11,
          lines: ['ROR-E401: this device is no longer enrolled; run `ror login`'],
        };
      if (answered.status === 200 || answered.status === 201) {
        const saved = savedOf(answered.text);
        lock.skills[saved.id] = {
          folder: name,
          slug: saved.slug,
          revision: saved.current_revision,
          exposed_digest: digest,
          managed: isManaged(name),
        };
        lines.push(`${name}: sent (revision ${String(saved.current_revision)})`);
        continue;
      }
      // refused or conflicting: keep the work apart, the server's version comes back below
      const where = keep(
        answered.status === 409 ? 'conflicts' : 'quarantine',
        slug,
        tree.files,
        now,
      );
      setAside = true;
      if (entry !== undefined) forget(lock, entry.id);
      lines.push(
        `${name}: ${answered.status === 409 ? 'changed elsewhere too' : `refused by the server (${String(answered.status)})`}; your copy is kept in ${where}`,
      );
      worse(30);
    } catch {
      lines.push(`${name}: could not be sent now (the server is unreachable); it stays as it is`);
      worse(30);
    }
  }

  // 2. DOWN: the signed library
  let answered;
  try {
    answered = await call(client, 'GET', '/library', {
      ...(lock.etag === null || setAside ? {} : { headers: { 'if-none-match': lock.etag } }),
    });
  } catch {
    saveLock(lock);
    return {
      code: 31,
      lines: [...lines, 'library: the server is unreachable; the folders stay as they are'],
    };
  }
  if (answered.status === 401)
    return { code: 11, lines: ['ROR-E401: this device is no longer enrolled; run `ror login`'] };
  if (answered.status === 304) {
    saveLock(lock);
    return { code, lines: lines.length === 0 ? ['library: up to date'] : lines };
  }
  if (answered.status !== 200) {
    saveLock(lock);
    return {
      code: 31,
      lines: [...lines, `library: the server answered ${String(answered.status)}`],
    };
  }
  let document: LibraryDocument;
  try {
    verifyBody(
      new TextEncoder().encode(answered.text),
      answered.headers.get(SIGNATURE_HEADER),
      pinnedKeys(enrolment),
    );
    document = LibraryDocumentSchema.parse(JSON.parse(answered.text));
  } catch (error) {
    saveLock(lock);
    if (error instanceof SignatureError)
      return { code: 32, lines: [...lines, `library: ${error.message}`] };
    return { code: 31, lines: [...lines, 'library: the document does not match the contract'] };
  }
  if (document.organization_id !== enrolment.organization_id) {
    return { code: 31, lines: [...lines, 'library: it is for another organization'] };
  }
  if (lock.member_id !== null && lock.member_id !== document.member_id) {
    return {
      code: 31,
      lines: [
        ...lines,
        'library: it is for another person than the one this device was first used by',
      ],
    };
  }
  if (
    lock.last_issued_at !== null &&
    Date.parse(document.issued_at) < Date.parse(lock.last_issued_at)
  ) {
    return {
      code: 32,
      lines: [...lines, 'library: older than the one already applied (rollback refused)'],
    };
  }

  const wanted = new Set<string>();
  const operations: ContractOperation[] = [];
  const written = new Map<
    string,
    { folder: string; slug: string; revision: number; digest: string }
  >();
  for (const skill of document.skills) {
    if (
      !skill.enabled ||
      !SKILLS_FOLDER.test(skill.folder) ||
      skill.folder !== folderOf(skill.slug) ||
      !isSlug(skill.slug)
    )
      continue;
    if (treeDigest(skill.files) !== skill.tree_digest) {
      lines.push(`${skill.folder}: refused, its files do not match their digest`);
      worse(32);
      continue;
    }
    wanted.add(skill.id);
    const dir = join(root, skill.folder);
    const entry = lock.skills[skill.id];
    const local = existsSync(dir) ? readTree(dir) : undefined;
    const same =
      local !== undefined &&
      treeDigest(local.files) === skill.tree_digest &&
      local.problems.length === 0;
    const stranger = local !== undefined && local.files.length > 0 && !isManaged(skill.folder);
    if (same) {
      // already what the server exposes: written again only to keep the managed lock's hashes current
      if (!stranger) operations.push(...writeOps(skill.folder, skill.files));
      lock.skills[skill.id] = {
        folder: skill.folder,
        slug: skill.slug,
        revision: skill.revision,
        exposed_digest: skill.tree_digest,
        managed: !stranger,
      };
    } else if (stranger) {
      // a folder of ours by name that ror never wrote and that differs: kept as it is, a copy of the
      // server's version waits aside; ror does not overwrite what it does not own
      const where = keep('conflicts', skill.slug, skill.files, now);
      lines.push(
        `${skill.folder}: a different copy is here and ror did not write it; it is left as it is, the server's version is in ${where}`,
      );
      lock.skills[skill.id] = {
        folder: skill.folder,
        slug: skill.slug,
        revision: skill.revision,
        exposed_digest: treeDigest(local.files),
        managed: false,
      };
      worse(30);
    } else {
      operations.push(...writeOps(skill.folder, skill.files));
      written.set(skill.id, {
        folder: skill.folder,
        slug: skill.slug,
        revision: skill.revision,
        digest: skill.tree_digest,
      });
      lines.push(
        `${skill.folder}: ${entry === undefined ? 'added' : 'updated'} (revision ${String(skill.revision)})`,
      );
    }
    removeState(rorHome(), baseRel(skill.id));
    writeTreeState(baseRel(skill.id), skill.files);
  }
  // 3. leaving discovery: switched off, deleted, or no longer exposed: the apply retires what ror wrote
  const leaving = Object.entries(lock.skills).filter(([id]) => !wanted.has(id));
  for (const [id, entry] of leaving) {
    const dir = join(root, entry.folder);
    if (SKILLS_FOLDER.test(entry.folder) && existsSync(dir)) {
      const tree = readTree(dir);
      if (treeDigest(tree.files) !== entry.exposed_digest) {
        const where = keep('quarantine', entry.slug, tree.files, now);
        lines.push(`${entry.folder}: left with unsent changes; they are kept in ${where}`);
        worse(30);
      } else {
        lines.push(`${entry.folder}: removed`);
      }
    }
    forget(lock, id);
    removeState(rorHome(), baseRel(id));
  }
  try {
    // apart from the rest: the writer checks every path before it writes any, and the folder is not there yet
    if (!existsSync(root)) applyManaged([rootOp(env)], layer, { extended: true });
    const result = applyManaged([rootOp(env), ...operations], layer, {
      retire: 'unchanged-only',
      extended: true,
    });
    for (const path of result.kept) lines.push(`${path}: edited by hand, kept`);
    if (result.kept.length > 0) worse(30);
  } catch (error) {
    if (error instanceof RefusedOperationError) {
      saveLock(lock);
      return { code: 31, lines: [...lines, `library: refused by the writer: ${error.message}`] };
    }
    throw error;
  }
  for (const [id, one] of written) {
    lock.skills[id] = {
      folder: one.folder,
      slug: one.slug,
      revision: one.revision,
      exposed_digest: one.digest,
      managed: true,
    };
  }

  lock.member_id = document.member_id;
  lock.last_issued_at = document.issued_at;
  lock.etag = answered.headers.get('etag');
  saveLock(lock);
  if (lines.length === 0) lines.push('library: up to date');
  return { code, lines };
}

// ------------------------------------------------------------------ commands on one skill

export interface SkillRef {
  readonly id: string;
  readonly entry: LockEntry;
}

export function findSkill(slugOrId: string): SkillRef | undefined {
  const lock = loadLock();
  for (const [id, entry] of Object.entries(lock.skills)) {
    if (id === slugOrId || entry.slug === slugOrId) return { id, entry };
  }
  return undefined;
}

export function listSkills(): readonly SkillRef[] {
  return Object.entries(loadLock().skills).map(([id, entry]) => ({ id, entry }));
}

/** A new skill folder with a SKILL.md to fill in; the next sync sends it. */
export function newSkill(
  env: Pick<LibraryEnv, 'skillsRoot'>,
  name: string,
): { folder: string; dir: string } {
  const slug = slugOf(name);
  if (slug === '') throw new Error('the name has no usable letter or digit');
  const folder = folderOf(slug);
  const dir = join(skillsRootOf(env), folder);
  if (existsSync(dir)) throw new Error(`${folder} already exists`);
  const title = name.replace(/[\r\n]/gu, ' ');
  applyManaged(
    writeOps(folder, [
      {
        path: 'SKILL.md',
        content: `---\nname: ${title}\ndescription: Say when this skill should be used\n---\n\n# ${title}\n\nWrite the instructions here.\n`,
      },
    ]),
    layerOf(env),
    { extended: true },
  );
  return { folder, dir };
}

/** A working copy outside discovery (ADR-0095): edit it freely, `activate` exposes a validated snapshot. */
export function editSkill(env: Pick<LibraryEnv, 'skillsRoot'>, ref: SkillRef): string {
  const work = workDirOf(ref.entry.slug);
  if (existsSync(work)) return work;
  const source = join(skillsRootOf(env), ref.entry.folder);
  writeTreeState(
    workRel(ref.entry.slug),
    readTree(existsSync(source) ? source : baseDirOf(ref.id)).files,
  );
  return work;
}

export interface Diff {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

export function diffTrees(from: readonly SkillFileInput[], to: readonly SkillFileInput[]): Diff {
  const before = new Map(from.map((file) => [file.path, file.content]));
  const after = new Map(to.map((file) => [file.path, file.content]));
  return {
    added: [...after.keys()].filter((path) => !before.has(path)).sort(),
    removed: [...before.keys()].filter((path) => !after.has(path)).sort(),
    changed: [...after.keys()]
      .filter((path) => before.has(path) && before.get(path) !== after.get(path))
      .sort(),
  };
}

/** Work against the server's exposed revision (the base) and against what the tool reads. */
export function diffSkill(
  env: Pick<LibraryEnv, 'skillsRoot'>,
  ref: SkillRef,
): { work: Diff | undefined; exposed: Diff } {
  const base = readTree(baseDirOf(ref.id)).files;
  const exposedDir = join(skillsRootOf(env), ref.entry.folder);
  const exposed = existsSync(exposedDir) ? readTree(exposedDir).files : [];
  const work = existsSync(workDirOf(ref.entry.slug))
    ? readTree(workDirOf(ref.entry.slug)).files
    : undefined;
  return {
    exposed: diffTrees(base, exposed),
    work: work === undefined ? undefined : diffTrees(base, work),
  };
}

/**
 * Expose the working copy: validate THAT tree whole, snapshot it, put exactly the snapshot in the
 * tool's folder (the files `ror` wrote that the snapshot no longer has are retired). Later edits of
 * the working copy wait for another `activate`.
 */
export function activateSkill(
  env: Pick<LibraryEnv, 'skillsRoot' | 'now'>,
  ref: SkillRef,
): { ok: true } | { ok: false; findings: Finding[] } {
  const work = workDirOf(ref.entry.slug);
  if (!existsSync(work)) throw new Error('there is no working copy: run `ror skills edit` first');
  const snapshot = readTree(work);
  const findings = localFindings(snapshot);
  if (findings.length > 0) return { ok: false, findings };
  const layer = layerOf(env);
  const prefix = `\${skills}/${ref.entry.folder}/`;
  const keepPaths = new Set(snapshot.files.map((file) => rootedFile(ref.entry.folder, file.path)));
  const stale = readLock(layer.lockPath)
    .entries.filter((entry) => entry.kind === undefined && entry.block_id === undefined)
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(prefix) && !keepPaths.has(path));
  applyManaged(
    [
      ...writeOps(ref.entry.folder, snapshot.files),
      ...stale.map((path): ContractOperation => ({ op: 'remove_managed', path })),
    ],
    layer,
    { extended: true },
  );
  return { ok: true };
}
