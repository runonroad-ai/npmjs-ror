/**
 * The planner of `ror sync` (SPEC-006 §2-3, ADR-0119 points 4 and 8): what a bundle asks for is
 * checked as a whole and lowered to what the managed writer executes, before the first write. A
 * refused bundle writes nothing. `git_exclude` becomes a managed block of the repository's own
 * exclude file; the `${project}`, `${home}` and `${codex_home}` inside a value are the device's.
 */
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ContractOperation } from '@runonroad/api-contract';
import { clientEnvironment, gitSafeEnvironment } from '@runonroad/config/client';

import type { Layer as ManagedLayer } from './managed.js';
import {
  RefusedError,
  checkExcludePattern,
  foldCase,
  defaultHome,
  resolveRooted,
  rootsOf,
  type Layer,
  type Roots,
} from './paths.js';

export const EXCLUDE_BLOCK = 'git-exclude';

export interface PlanContext {
  readonly layer: Layer;
  readonly roots: Roots;
  /** The repository's common git folder (`git rev-parse --git-common-dir`), when there is one. */
  readonly gitDir: string | undefined;
  /** Tools sharing a project each keep their own exclude block, or one sync would drift the other. */
  readonly target?: string;
}

export interface Planned {
  readonly operations: readonly ContractOperation[];
  readonly layer: Omit<ManagedLayer, 'lockPath'>;
}

/** The git root of a directory, or the directory itself outside a repository. */
export function projectRootOf(directory: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitSafeEnvironment(),
    }).trim();
  } catch {
    return resolve(directory);
  }
}

/** The common git folder of the repository the project is in (linked worktrees share its `info/exclude`). */
export function gitDirOf(projectDir: string): string | undefined {
  try {
    const path = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitSafeEnvironment(),
    }).trim();
    return resolve(projectDir, path);
  } catch {
    return undefined;
  }
}

/** `${project}`, `${home}` and `${codex_home}` inside a value are the device's, like the roots of a path. */
function withRoots(
  value: unknown,
  context: PlanContext,
  escape: (text: string) => string = (text) => text,
): unknown {
  if (typeof value === 'string') {
    const project = context.roots.project;
    if (value.includes('${project}') && project === undefined) {
      throw new RefusedError('a value names ${project}, which this layer does not serve');
    }
    const codexHome = clientEnvironment().codexHome ?? join(context.roots.home, '.codex');
    return value
      .replaceAll('${project}', escape(project ?? ''))
      .replaceAll('${codex_home}', escape(codexHome))
      .replaceAll('${home}', escape(context.roots.home));
  }
  if (Array.isArray(value)) return value.map((item) => withRoots(item, context, escape));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withRoots(item, context, escape)]),
    );
  }
  return value;
}

/** A path inside a TOML basic string. */
const escapeToml = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

/**
 * A root of the user layer that lives under the home (`~/.codex`, `~/.claude`, `~/.agents`) is named
 * through `${home}`, which always exists: the folder of a tool never opened yet is created by the
 * write, like any parent, and the lock spells the path the same whether or not it exists. A root
 * elsewhere (a `CODEX_HOME` set by hand) keeps its name and must exist.
 */
function underHome(path: string, context: PlanContext): string {
  if (context.layer !== 'user') return path;
  const match = /^\$\{([a-z_]+)\}\/(.+)$/su.exec(path);
  const name = match?.[1] ?? '';
  if (name === 'home' || name === 'project' || match === null) return path;
  const root = rootsOf(context.layer, context.roots)[name];
  if (root === undefined) return path;
  const home = context.roots.home;
  const from = relative(home, root);
  if (from === '' || from.startsWith('..') || isAbsolute(from)) return path;
  return `\${home}/${from.split(sep).join('/')}/${match[2] ?? ''}`;
}

const rooted = <T extends ContractOperation>(operation: T, context: PlanContext): T =>
  'path' in operation && typeof operation.path === 'string'
    ? { ...operation, path: underHome(operation.path, context) }
    : operation;

export function plan(operations: readonly ContractOperation[], context: PlanContext): Planned {
  const lowered: ContractOperation[] = [];
  const patterns: string[] = [];
  const written = new Set<string>();
  const edited = new Set<string>();
  const pointers = new Map<string, string[]>();

  const claim = (path: string): void => {
    const key = foldCase(path);
    if (written.has(key)) throw new RefusedError(`"${path}" is written twice`);
    if (edited.has(key)) throw new RefusedError(`"${path}" is written whole and edited in part`);
    written.add(key);
  };

  for (const operation of operations) {
    if ('path' in operation && typeof operation.path === 'string') {
      if (operation.path.startsWith('${git}/')) {
        throw new RefusedError('a bundle cannot name the repository folder of git');
      }
    }
    switch (operation.op) {
      case 'write_file':
        claim(resolveRooted(operation.path, context.layer, context.roots));
        lowered.push(rooted(operation, context));
        break;
      case 'ensure_dir':
        resolveRooted(operation.path, context.layer, context.roots);
        lowered.push(rooted(operation, context));
        break;
      case 'managed_block': {
        const path = resolveRooted(operation.path, context.layer, context.roots);
        if (written.has(foldCase(path))) {
          throw new RefusedError(`"${path}" is written whole and edited in part`);
        }
        edited.add(foldCase(path));
        lowered.push({
          ...rooted(operation, context),
          content: withRoots(
            operation.content,
            context,
            operation.path.endsWith('.toml') ? escapeToml : undefined,
          ) as string,
        });
        break;
      }
      case 'git_exclude':
        checkExcludePattern(operation.pattern);
        patterns.push(operation.pattern);
        break;
      case 'remove_managed':
        if (operation.owner !== undefined) {
          throw new RefusedError('remove_managed by owner is not supported by this ror');
        }
        lowered.push(rooted(operation, context));
        break;
      case 'merge_json': {
        if (operation.strategy === 'remove') {
          throw new RefusedError('merge_json with strategy remove is not supported by this ror');
        }
        if (!operation.path.endsWith('.json')) {
          throw new RefusedError(`merge_json only edits .json files, not "${operation.path}"`);
        }
        const path = resolveRooted(operation.path, context.layer, context.roots);
        if (written.has(foldCase(path))) {
          throw new RefusedError(`"${path}" is written whole and edited in part`);
        }
        edited.add(foldCase(path));
        const earlier = pointers.get(foldCase(path)) ?? [];
        if (earlier.some((other) => operation.pointer === other)) {
          throw new RefusedError(`"${operation.pointer}" of "${path}" is merged twice`);
        }
        pointers.set(foldCase(path), [...earlier, operation.pointer]);
        lowered.push({ ...rooted(operation, context), value: withRoots(operation.value, context) });
        break;
      }
      case 'merge_toml':
      case 'run_tool_command':
        throw new RefusedError(`operation ${operation.op} is not supported by this ror`);
    }
  }

  const roots: Record<string, string> = { ...rootsOf(context.layer, context.roots) };
  if (patterns.length > 0) {
    if (context.gitDir === undefined) throw new RefusedError('git_exclude needs a git repository');
    roots['git'] = context.gitDir;
    lowered.push({
      op: 'managed_block',
      path: '${git}/info/exclude',
      block_id:
        context.target === undefined || context.target === 'claude_code'
          ? EXCLUDE_BLOCK
          : `${EXCLUDE_BLOCK}-${context.target}`,
      comment_style: 'hash',
      content: patterns.join('\n'),
    });
  } else if (context.gitDir !== undefined) {
    // an exclude block an earlier sync wrote must still resolve when this one asks for none
    roots['git'] = context.gitDir;
  }
  return { operations: lowered, layer: { roots } };
}

/** Where a project's lock of one tool lives (the project is governed for that tool while it exists). */
export const lockFileOf = (projectDir: string, target: string): string =>
  join(projectDir, '.runonroad', 'lock', `${target}.json`);

/** The managed layer of one lock: the roots its entries were written under, and where the lock is. */
export function layerOf(
  layer: Layer,
  lockPath: string,
  projectDir: string | undefined,
): ManagedLayer {
  const roots: Record<string, string> = {
    ...rootsOf(layer, { project: projectDir, home: defaultHome() }),
  };
  const git = layer === 'project' && projectDir !== undefined ? gitDirOf(projectDir) : undefined;
  if (git !== undefined) roots['git'] = git;
  return { roots, lockPath };
}
