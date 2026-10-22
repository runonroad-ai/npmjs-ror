/**
 * The npm package every install channel installs (ADR-0084 §4): packed and installed the way a
 * workstation gets it, so a runtime import left out of the bundle fails here, not on a laptop.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'ror-pack-'));

function sh(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status)}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

let tarball = '';

beforeAll(() => {
  sh('pnpm', ['pack', '--pack-destination', work], root);
  const name = readdirSync(work).find((file) => file.endsWith('.tgz'));
  if (name === undefined) throw new Error('pnpm pack wrote no tarball');
  tarball = join(work, name);
}, 120_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

it('packs a manifest whose only runtime dependency is @napi-rs/keyring', () => {
  const text = sh('tar', ['-xzOf', tarball, 'package/package.json'], work);
  const manifest = JSON.parse(text) as { private?: boolean; dependencies?: object };

  expect(manifest.private).toBeUndefined();
  expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@napi-rs/keyring']);
  expect(text).not.toContain('workspace:');
});

it('packs the Apache-2.0 licence text the published package owes its users', () => {
  expect(sh('tar', ['-xzOf', tarball, 'package/LICENSE'], work)).toContain(
    'Apache License\n                           Version 2.0',
  );
});

const prefix = join(work, 'prefix');

function installed(verb: string) {
  return spawnSync(join(prefix, 'node_modules/.bin/ror'), [verb], {
    cwd: prefix,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
}

it('installs into an empty prefix where `ror help` exits 0', () => {
  sh(
    'npm',
    ['install', '--prefix', prefix, '--prefer-offline', '--no-audit', '--no-fund', tarball],
    work,
  );

  const ror = installed('help');

  expect(ror.stderr).toBe('');
  expect(ror.status).toBe(0);
  expect(ror.stdout).toContain('Usage: ror <command>');
}, 120_000);

it('prints as fingerprint the sha256 of the installed entry file', () => {
  const entry = readFileSync(join(prefix, 'node_modules/@runonroad/ror/dist/index.js'));
  const ror = installed('version');

  expect(ror.status).toBe(0);
  expect(ror.stdout).toContain(`fingerprint  ${createHash('sha256').update(entry).digest('hex')}`);
});

/** The package an input of the bundle belongs to: the nearest package.json above it with a name. */
function packageOf(input: string): string {
  // Some packages (zod/v4) nest a nameless package.json that only sets `type`.
  for (let dir = dirname(join(root, input)); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
    if (name !== undefined) return name;
  }
}

it('names every third-party package bundled into the entry file in THIRD_PARTY_NOTICES', () => {
  const meta = JSON.parse(readFileSync(join(root, 'dist/meta.json'), 'utf8')) as {
    inputs: Record<string, unknown>;
  };
  const bundled = new Set(
    Object.keys(meta.inputs)
      .filter((input) => !input.startsWith('src/'))
      .map(packageOf)
      .filter((name) => !name.startsWith('@runonroad/')),
  );
  const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES'), 'utf8');

  for (const name of bundled) expect(notices, `${name} is bundled`).toContain(name);
});
