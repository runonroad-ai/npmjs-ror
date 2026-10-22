// The `~/.runonroad` state (SPEC-007 §4): with the managed writer, the only module that writes
// files. Never a token: the token lives in the OS keychain (ADR-0084 §2).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SigningKey } from '@runonroad/api-contract';
import { parse, stringify } from 'yaml';

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

const stateDir = (home: string) => join(home, '.runonroad');

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, content, { mode: 0o644 });
  renameSync(temporary, path);
}

/** The config, or `{}` when `ror login` has never run. */
export function readConfig(home: string): RorConfig {
  const path = join(stateDir(home), 'config.yaml');
  return existsSync(path) ? ((parse(readFileSync(path, 'utf8')) ?? {}) as RorConfig) : {};
}

/** Records the server and organization, keeping any other key already in the file. */
export function writeLogin(home: string, config: Required<RorConfig>, pinned: PinnedKeys): void {
  mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  writeAtomic(join(stateDir(home), 'config.yaml'), stringify({ ...readConfig(home), ...config }));
  writeAtomic(join(stateDir(home), 'signing-keys.json'), `${JSON.stringify(pinned, null, 2)}\n`);
}
