// `ror version` (SPEC-007 §2): the version, its channel and the fingerprint of the running file.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Output } from './cli.js';

/** The version of the installed package, set at build in its package.json. */
export function packageVersion(): string {
  const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

/** A semver pre-release (`1.2.3-beta.1`) is `prerelease`; a plain `x.y.z` is `stable`. */
export const channelOf = (version: string): 'stable' | 'prerelease' =>
  version.includes('-') ? 'prerelease' : 'stable';

export function version(_: readonly string[], output: Output): number {
  const current = packageVersion();
  // Once bundled this module is the entry file, so the hash is the one published with the release.
  const fingerprint = createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex');
  output.out(`version      ${current}`);
  output.out(`channel      ${channelOf(current)}`);
  output.out(`fingerprint  ${fingerprint}`);
  return 0;
}
