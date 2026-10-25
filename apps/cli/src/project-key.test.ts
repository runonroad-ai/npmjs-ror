import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { projectKey } from './state.js';

/** One project, one key, whatever the spelling of its path (a link, a dot segment): the cache and the hook agree. */
describe('projectKey', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('is the same for a project and for a link to it', () => {
    const real = mkdtempSync(join(tmpdir(), 'ror-key-real-'));
    const holder = mkdtempSync(join(tmpdir(), 'ror-key-link-'));
    made.push(real, holder);
    const link = join(holder, 'project');
    // a junction needs no privilege on Windows; POSIX ignores the type
    symlinkSync(real, link, 'junction');
    expect(projectKey(link)).toBe(projectKey(real));
  });

  it('ignores dot segments and a trailing separator', () => {
    const real = mkdtempSync(join(tmpdir(), 'ror-key-dots-'));
    made.push(real);
    expect(projectKey(join(real, 'a', '..'))).toBe(projectKey(real));
    expect(projectKey(`${real}/`)).toBe(projectKey(real));
  });

  it('still answers for a folder that does not exist yet', () => {
    const missing = join(tmpdir(), 'ror-key-missing-never-created');
    expect(projectKey(missing)).toMatch(/^[0-9a-f]{16}$/u);
  });
});
