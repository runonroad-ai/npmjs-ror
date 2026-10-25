// ADR-0007: only the managed writer and the `~/.runonroad` state module (#731, `state.ts`)
// import a file-writing function of `node:fs`. Tests and the fixtures of `testing/` are left out: they write.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ALLOWED = new Set(['managed.ts', 'state.ts']);
const WRITERS =
  /^(?:default|promises|open|write|writev|writeFile|appendFile|createWriteStream|rename|rm|rmdir|unlink|mkdir|mkdtemp|copyFile|cp|symlink|link|truncate|ftruncate|chmod|chown|utimes)(?:Sync)?$/u;
const FS_IMPORT = /(?:import|export)\s+([^;]*?)\s+from\s+['"](?:node:)?fs(?:\/promises)?['"]/gu;

/** The file-writing functions a module imports from `node:fs`; a whole-module import counts. */
function fsWriters(source: string): string[] {
  if (/(?:import|require)\(\s*['"](?:node:)?fs/u.test(source)) return ['dynamic import'];
  return [...source.matchAll(FS_IMPORT)].flatMap(([, clause = '']) => {
    if (!clause.startsWith('{')) return [clause];
    return clause
      .slice(1, -1)
      .split(',')
      .map(
        (name) =>
          name
            .replace(/^\s*type\s+/u, '')
            .split(/\s+as\s+/u)[0]
            ?.trim() ?? '',
      )
      .filter((name) => WRITERS.test(name));
  });
}

describe('which modules write files', () => {
  it('detects writers, whole-module and dynamic imports', () => {
    expect(fsWriters("import { readFileSync, writeFileSync as w } from 'node:fs';")).toEqual([
      'writeFileSync',
    ]);
    expect(fsWriters("import * as fs from 'fs';")).toEqual(['* as fs']);
    expect(fsWriters("import { rm } from 'node:fs/promises';")).toEqual(['rm']);
    expect(fsWriters("const fs = await import('node:fs');")).toEqual(['dynamic import']);
    expect(fsWriters("import { default as fs } from 'node:fs';")).toEqual(['default']);
    expect(fsWriters("import { writev } from 'node:fs';")).toEqual(['writev']);
    expect(fsWriters("export { writeFileSync } from 'node:fs';")).toEqual(['writeFileSync']);
    expect(fsWriters("import { readFileSync } from 'node:fs';")).toEqual([]);
  });

  it('is only the managed writer and the state module', () => {
    const src = fileURLToPath(new URL('.', import.meta.url));
    // Windows lists `testing\\x.ts`: one spelling for the match
    const offenders = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .map((file) => file.replaceAll('\\', '/'))
      .filter(
        (file) =>
          file.endsWith('.ts') &&
          !file.endsWith('.test.ts') &&
          !file.startsWith('testing/') &&
          !ALLOWED.has(file),
      )
      .filter((file) => fsWriters(readFileSync(`${src}/${file}`, 'utf8')).length > 0);
    expect(offenders).toEqual([]);
  });
});
