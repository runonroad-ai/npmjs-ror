import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { run } from './cli.js';
import { unknownFlags } from './flags.js';
import { channelOf } from './version.js';

async function ror(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    env: {},
    home: '/nonexistent',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('ror help', () => {
  it('lists the verbs and exits 0', async () => {
    const { code, out, err } = await ror('help');
    expect(code).toBe(0);
    expect(out).toContain('Commands:');
    expect(out).toMatch(/^ {2}help\s+Prints this page/mu);
    expect(err).toBe('');
  });

  it('is what a bare `ror`, `--help` and `-h` print', async () => {
    const page = (await ror('help')).out;
    for (const argv of [[], ['--help'], ['-h']]) {
      expect(await ror(...argv)).toEqual({ code: 0, out: page, err: '' });
    }
  });
});

describe('ror version', () => {
  it('prints the package version, its channel and a sha256, and exits 0', async () => {
    const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const { version } = JSON.parse(manifest) as { version: string };
    const { code, out, err } = await ror('version');
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toMatch(new RegExp(`^version {6}${version.replaceAll('.', '\\.')}$`, 'mu'));
    expect(out).toMatch(/^channel {6}(stable|prerelease)$/mu);
    expect(out).toMatch(/^fingerprint {2}[0-9a-f]{64}$/mu);
  });

  it('names the channel from the version', () => {
    expect(channelOf('1.2.3')).toBe('stable');
    expect(channelOf('1.2.3-beta.1')).toBe('prerelease');
  });
});

describe('a refused input exits non-zero', () => {
  it('refuses an unknown flag instead of ignoring it', async () => {
    const { code, out, err } = await ror('help', '--json');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('Unknown option for `help`: --json');
    expect(err).toContain('Accepted: none');
  });

  it('refuses an unknown command and prints the help on stderr', async () => {
    const { code, out, err } = await ror('deploy');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('Unknown command: deploy');
    expect(err).toContain('Commands:');
  });

  it('refuses a flag in place of a command', async () => {
    expect((await ror('--verbose')).code).toBe(1);
  });

  it('refuses a value flag with no value, as a usage error', async () => {
    const { code, err } = await ror('login', '--server', '--org', 'acme');
    expect(code).toBe(2);
    expect(err).toContain('ROR-E001 --server needs a value');
  });
});

describe('unknownFlags', () => {
  it('returns every unknown flag in the order typed, and no positional', () => {
    expect(unknownFlags('help', ['--verbose', 'x', '-', '--quiet'])).toEqual([
      '--verbose',
      '--quiet',
    ]);
  });
});
