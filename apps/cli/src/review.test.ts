/**
 * Each case here is a bypass or a false positive that an adversarial review of
 * the hook found (Codex, 2026-10-17). They stay as tests so they stay fixed.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evaluate,
  evaluateWithoutPolicy,
  type PolicyRule,
  type PolicyView,
  type ToolCall,
} from './evaluate.js';

const rule = (overrides: Partial<PolicyRule> & { id: string }): PolicyRule =>
  ({
    kind: 'path',
    decision: 'forbid',
    reason: 'No.',
    required: true,
    access: 'any',
    glob: 'vault/**',
    ...overrides,
  }) as PolicyRule;

const forcePush: PolicyRule = {
  id: 'push',
  kind: 'command',
  decision: 'forbid',
  reason: 'No force.',
  required: false,
  executable: 'git',
  argv_prefix: ['push'],
  flags_any: ['--force', '-f'],
};

let root: string;
let home: string;
let ror: string;
const roots = () => ({ project: root, home, ror });
const view = (...rules: PolicyRule[]): PolicyView => ({ rules, mcp_allow: [] });
const call = (tool_name: string, tool_input: Record<string, unknown>, cwd = root): ToolCall => ({
  tool_name,
  tool_input,
  cwd,
});
const bash = (command: string, cwd = root): ToolCall => call('Bash', { command }, cwd);
const decide = (policy: PolicyView, toolCall: ToolCall) => evaluate(policy, toolCall, roots());
const denied = (policy: PolicyView, toolCall: ToolCall): boolean => !decide(policy, toolCall).allow;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ror-review-'));
  home = mkdtempSync(join(tmpdir(), 'ror-reviewhome-'));
  ror = join(home, '.runonroad');
  mkdirSync(join(root, 'vault', 'sub'), { recursive: true });
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'vault', 'key'), 'TOPSECRET');
  writeFileSync(join(root, 'vault', 'sub', 'inner'), 'TOPSECRET');
  writeFileSync(join(root, 'dist', 'app.js'), 'x');
  symlinkSync(join(root, 'vault', 'sub'), join(root, 'link'));
  symlinkSync(join(root, 'vault', 'new-file'), join(root, 'dangling'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// a Windows path pasted into a Bash command is spelled with `/`: in the shell a backslash is an escape
const posix = (path: string): string => path.replaceAll('\\', '/');

describe('the files that hold the rules up are not the agent’s to change', () => {
  const empty = view();
  const files = [
    join('.runonroad', 'lock', 'claude_code.policy.json'),
    join('.runonroad', 'lock', 'claude_code.json'),
    join('.claude', 'settings.local.json'),
    join('.claude', 'settings.json'),
  ];

  it.each(files)('refuses writing %s with the built-in tools', (file) => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(denied(empty, call(tool, { file_path: join(root, file), content: '{}' })), tool).toBe(
        true,
      );
    }
  });

  it.each([
    'echo {} > .runonroad/lock/claude_code.policy.json',
    'rm .claude/settings.local.json',
    'sed -i s/enabled/disabled/ .claude/settings.local.json',
    'tee .claude/settings.json < /dev/null',
    'cp /tmp/old.json .runonroad/lock/claude_code.json',
    'echo {} > @HOME@/.claude/settings.json',
    'dd if=/dev/null of=.claude/settings.local.json',
  ])('refuses the shell command %s', (command) => {
    expect(denied(empty, bash(command.replace('@HOME@', posix(home))))).toBe(true);
  });

  it('refuses them whatever the policy says, and when there is no usable policy', () => {
    const write = call('Write', { file_path: join(root, files[0] ?? ''), content: '{}' });
    expect(evaluateWithoutPolicy(write, 'expired', roots())).toMatchObject({ allow: false });
    expect(
      evaluateWithoutPolicy(bash('rm .claude/settings.local.json'), 'x', roots()),
    ).toMatchObject({ allow: false });
  });

  it('lets the agent read the project settings, and keeps the device token away', () => {
    expect(
      denied(empty, call('Read', { file_path: join(root, '.claude', 'settings.local.json') })),
    ).toBe(false);
    expect(denied(empty, call('Read', { file_path: join(ror, 'enrolment.json') }))).toBe(true);
    expect(denied(empty, bash(`cat ${posix(join(ror, 'enrolment.json'))}`))).toBe(true);
  });
});

describe('searching', () => {
  const policy = view(rule({ id: 'vault' }));
  it('refuses a Glob whose pattern starts in the vault, from any base', () => {
    expect(denied(policy, call('Glob', { pattern: 'vault/**' }))).toBe(true);
    expect(denied(policy, call('Glob', { pattern: 'vault/sub/*.txt', path: '.' }))).toBe(true);
    expect(denied(policy, call('Glob', { pattern: '**/*.md' }))).toBe(false);
  });
});

describe('the shell, read the way the shell reads it', () => {
  const policy = view(rule({ id: 'vault' }), forcePush);
  it('removes a backslash-newline continuation like the shell does', () => {
    expect(denied(policy, bash('git pu\\\nsh --force'))).toBe(true);
    expect(denied(policy, bash('git push --for\\\nce'))).toBe(true);
  });
  it('does not let a cd in a subshell hide the directory the next command runs in (it reads both)', () => {
    expect(denied(policy, bash('(cd /tmp); cat vault/key'))).toBe(true);
  });
});

describe('symbolic links, followed where they stand', () => {
  const policy = view(rule({ id: 'vault' }));
  it('reaches the vault through link/..', () => {
    expect(denied(policy, call('Read', { file_path: `${root}/link/../key` }))).toBe(true);
    expect(denied(policy, bash('cat link/../key'))).toBe(true);
  });
  it('sees where a link leads even when its target does not exist yet', () => {
    expect(denied(policy, call('Write', { file_path: join(root, 'dangling'), content: 'x' }))).toBe(
      true,
    );
  });
  it('still reads an ordinary link to a file outside the vault', () => {
    symlinkSync(join(root, 'dist', 'app.js'), join(root, 'ok-link'));
    expect(denied(policy, call('Read', { file_path: join(root, 'ok-link') }))).toBe(false);
  });
});

describe('globs', () => {
  it('treats a trailing slash and a trailing /** the same', () => {
    for (const glob of ['vault/', 'vault', 'vault/**', './vault/']) {
      expect(
        denied(view(rule({ id: 'v', glob })), call('Read', { file_path: 'vault/key' })),
        glob,
      ).toBe(true);
    }
  });
  it('matches the same name written in another Unicode form', () => {
    const accent = rule({ id: 'accent', glob: 'café/**' });
    expect(denied(view(accent), call('Read', { file_path: 'café/menu' }))).toBe(true);
  });
});

describe('what is ordinary use and must not be refused', () => {
  const policy = view(rule({ id: 'vault' }), forcePush);
  it('prints text that mentions a forbidden command', () => {
    for (const command of [
      'echo git push --force',
      'echo "git push -f"',
      `grep "git push --force" README.md`,
      'printf "%s" "git push -f"',
    ]) {
      expect(denied(policy, bash(command)), command).toBe(false);
    }
  });
  it('still sees the command behind a wrapper or a shell', () => {
    for (const command of [
      'sudo -u bob git push --force',
      'timeout 30 git push -f',
      'nohup git push --force &',
      'bash -c "git push --force"',
      'ssh host "git push -f"',
    ]) {
      expect(denied(policy, bash(command)), command).toBe(true);
    }
  });
  it('reads a write-only path freely, and refuses what changes it', () => {
    const noWrite = view(rule({ id: 'dist', access: 'write', glob: 'dist' }));
    for (const command of [
      'cat dist/app.js',
      'ls dist',
      'grep x dist/app.js',
      'wc -l < dist/app.js',
    ]) {
      expect(denied(noWrite, bash(command)), command).toBe(false);
    }
    for (const command of [
      'echo x > dist/app.js',
      'echo x >> dist/new.js',
      'cp a dist/app.js',
      'mv dist/app.js b',
      'rm dist/app.js',
      'touch dist/new.js',
      'sed -i s/x/y/ dist/app.js',
      'dd if=/dev/zero of=dist/app.js',
      'tee dist/app.js < a',
    ]) {
      expect(denied(noWrite, bash(command)), command).toBe(true);
    }
  });
  it('reads a read-only path as read, and lets a write into it alone', () => {
    const noRead = view(rule({ id: 'vault', access: 'read' }));
    expect(denied(noRead, bash('cat vault/key'))).toBe(true);
    expect(denied(noRead, bash('echo x > vault/new'))).toBe(false);
  });
});

describe('the glob contract, as the hook reads it', () => {
  it('lets ** stand for zero or more directories, and no more than that', () => {
    const policy = view(rule({ id: 'deep', glob: 'a/**/b' }));
    for (const path of ['a/b', 'a/x/b', 'a/x/y/b', 'a/b/c']) {
      expect(denied(policy, call('Read', { file_path: `${root}/${path}` })), path).toBe(true);
    }
    expect(denied(policy, call('Read', { file_path: `${root}/a/xb` }))).toBe(false);
    expect(denied(policy, call('Read', { file_path: `${root}/ab` }))).toBe(false);
  });
  it('matches a leading ** anywhere', () => {
    const policy = view(rule({ id: 'any-key', glob: '**/id_rsa' }));
    expect(denied(policy, call('Read', { file_path: `${root}/id_rsa` }))).toBe(true);
    expect(denied(policy, call('Read', { file_path: `${root}/x/y/id_rsa` }))).toBe(true);
    expect(denied(policy, call('Read', { file_path: `${root}/x/id_rsa.pub` }))).toBe(false);
  });
});

describe('with no usable policy, a call can read and talk to the person, and nothing else', () => {
  it('refuses the tools that start something else', () => {
    for (const name of [
      'Agent',
      'Task',
      'Skill',
      'WebFetch',
      'WebSearch',
      'Bash',
      'Write',
      'mcp__a__b',
    ]) {
      expect(evaluateWithoutPolicy(call(name, {}), 'expired', roots()), name).toMatchObject({
        allow: false,
      });
    }
    for (const name of ['Read', 'Grep', 'Glob', 'TodoWrite', 'AskUserQuestion']) {
      expect(
        evaluateWithoutPolicy(call(name, { file_path: 'README.md' }), 'expired', roots()),
        name,
      ).toEqual({ allow: true });
    }
  });
});
