import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from './cli.js';
import { unknownFlags } from './flags.js';
import { status } from './status.js';
import { sync } from './sync.js';
import { saveEnrolment } from './testing/enrol.js';
import { fakeServer, KEY, type Fake } from './testing/fake-server.js';
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

describe('ror status after a hand edit of a managed file', () => {
  let fake: Fake;
  let home: string;
  let project: string;
  const governance = (): string => join(project, '.claude', 'rules', 'ror-governance.md');

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ror-cli-home-'));
    project = mkdtempSync(join(tmpdir(), 'ror-cli-project-'));
    process.env['RUNONROAD_HOME'] = join(home, '.runonroad');
    process.env['HOME'] = home;
    process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude');
    execFileSync('git', ['init', '-q'], { cwd: project });
    fake = await fakeServer();
    fake.next = {
      operations: [
        {
          op: 'write_file',
          path: '${project}/.claude/rules/ror-governance.md',
          content:
            '# RunOnRoad governance\n<!-- Managed by RunOnRoad — do not edit -->\nNo vault.\n',
        },
      ],
      policy: {
        schema_version: 1,
        principal: 'mem_lea',
        mcp_allow: [],
        rules: [
          {
            id: 'g@1.0.0:no-vault',
            source: 'g@1.0.0',
            kind: 'path',
            decision: 'forbid',
            reason: 'Credentials stay in the vault.',
            required: true,
            access: 'any',
            glob: 'vault/**',
          },
        ],
      },
    };
    const enrolment = {
      api: fake.url,
      device_token: `rord_${'a'.repeat(43)}`,
      organization_id: 'org_test',
      keys: [KEY],
    };
    saveEnrolment(enrolment);
    const capabilities = { sandbox: true, claudeVersion: '2.1.301' };
    await sync(
      { fetch, now: () => new Date('2026-10-17T12:00:00.000Z'), projectDir: project, capabilities },
      enrolment,
    );
  });

  afterEach(() => {
    fake.server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('lists the file as drift, turns enforcement not active and exits 40', async () => {
    expect(status(project).drifted).toEqual([]);
    writeFileSync(governance(), `${readFileSync(governance(), 'utf8')}Vault is fine.\n`);
    const report = status(project);
    // the lock keeps the path as the bundle wrote it, with its `${project}` root
    expect(report.drifted).toEqual(['${project}/.claude/rules/ror-governance.md']);
    expect(report.enforcement).toMatchObject({ active: false });
    expect(report.enforcement?.why).toContain('drifted');
    const { code, out } = await ror('status', '--project-dir', project);
    expect(code).toBe(40);
    expect(out).toContain('drift: ${project}/.claude/rules/ror-governance.md');
    expect(out).toContain('enforcement: NOT ACTIVE');
  });
});
