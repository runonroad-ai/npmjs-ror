import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>;
  files?: string[];
};

it.runIf('@napi-rs/keyring' in (manifest.dependencies ?? {}))(
  'packs THIRD_PARTY_NOTICES with the libdbus AFL-2.1 notice (ADR-0088)',
  () => {
    expect(read('THIRD_PARTY_NOTICES')).toMatch(
      /libdbus[\s\S]*Academic Free License version 2\.1/u,
    );
    expect(manifest.files).toContain('THIRD_PARTY_NOTICES');
  },
);
