/**
 * The bundle of `ror hook` (ADR-0008, ADR-0112): its own entry, apart from `dist/index.js`, made of the
 * code of `ror` and Node's own modules only — no library compiled on a tool call, no network on its path —
 * and a refusal when nothing here says the call is allowed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = join(root, 'dist/hook-main.js');
const home = mkdtempSync(join(tmpdir(), 'ror-hook-'));

beforeAll(() => {
  // pnpm is a `.cmd` shim on Windows: only a shell runs it
  const built = spawnSync('pnpm', ['build'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (built.status !== 0)
    throw new Error(`pnpm build exited ${String(built.status)}\n${built.stderr}`);
}, 120_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

it('imports nothing but the modules of Node', () => {
  const source = readFileSync(bundle, 'utf8');
  const imports = [...source.matchAll(/^import .*? from ["']([^"']+)["']/gmu)].map((m) => m[1]);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.filter((each) => !(each ?? '').startsWith('node:'))).toEqual([]);
  expect(source).not.toMatch(/\bfetch\s*\(|node:https?|node:net|node:tls/u);
});

it('refuses a tool call on a machine that never enrolled, and never fails open', () => {
  const run = spawnSync(process.execPath, [bundle], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: home }),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', RUNONROAD_HOME: home },
  });
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'deny' },
  });
});
