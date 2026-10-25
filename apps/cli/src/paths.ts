/**
 * Path roots and confinement (SPEC-006 §2, TASK-347). A bundle names paths
 * under a root (`${project}/…`); the device resolves the root and refuses
 * anything that leaves it, before any write.
 */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { clientEnvironment } from '@runonroad/config/client';

export type Layer = 'user' | 'project';

export class RefusedError extends Error {
  override readonly name = 'RefusedError';
}

export interface Roots {
  readonly project: string | undefined;
  readonly home: string;
}

/** The roots a layer serves: the project layer never reaches the user's home. */
export function rootsOf(layer: Layer, roots: Roots): Readonly<Record<string, string>> {
  if (layer === 'project') {
    return roots.project === undefined ? {} : { project: roots.project };
  }
  const environment = clientEnvironment();
  const claude = environment.claudeConfigDir ?? join(roots.home, '.claude');
  return {
    home: roots.home,
    claude_config: claude,
    agents_home: join(roots.home, '.agents'),
    codex_home: environment.codexHome ?? join(roots.home, '.codex'),
  };
}

export const defaultHome = (): string => clientEnvironment().home ?? homedir();

const ROOTED = /^\$\{([a-z_]+)\}\/(.+)$/u;

/** `${project}/.claude/x.md` → an absolute path inside the root, or a refusal. */
export function resolveRooted(path: string, layer: Layer, roots: Roots): string {
  const match = ROOTED.exec(path);
  if (match === null) throw new RefusedError(`path "${path}" has no root`);
  const root = rootsOf(layer, roots)[match[1] ?? ''];
  if (root === undefined) {
    throw new RefusedError(`path "${path}" is under a root the ${layer} layer does not serve`);
  }
  const segments = (match[2] ?? '').split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[\\\0]/u.test(segment)) {
      throw new RefusedError(`path "${path}" is not in its canonical form`);
    }
  }
  assertNoSymlink(root, segments);
  return join(root, ...segments);
}

/** A symlink below the root could point a managed write anywhere. */
function assertNoSymlink(root: string, segments: readonly string[]): void {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new RefusedError(`"${current}" is a symbolic link`);
      }
    } catch (error) {
      if (error instanceof RefusedError) throw error;
      return; // does not exist yet: nothing below it can be a link
    }
  }
}

/** git reads these patterns itself; we accept only what the compiler emits. */
export function checkExcludePattern(pattern: string): void {
  const bad =
    pattern === '' ||
    // eslint-disable-next-line no-control-regex -- C0 and DEL are refused on purpose
    /[\u0000-\u001f\u007f]/u.test(pattern) ||
    pattern !== pattern.trim() ||
    /[[\]]/u.test(pattern) ||
    pattern.startsWith('!') ||
    pattern.startsWith('#') ||
    !/[^*?/.]/u.test(pattern);
  if (bad) throw new RefusedError(`git_exclude pattern ${JSON.stringify(pattern)} is refused`);
}

/** One name per file, whatever the case or the platform (« écrit deux fois »). */
export const foldCase = (path: string): string => path.toUpperCase().toLowerCase();

export const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
