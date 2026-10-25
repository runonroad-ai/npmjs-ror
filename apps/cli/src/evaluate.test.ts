import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evaluate,
  evaluateWithoutPolicy,
  globToRegExp,
  type PolicyRule,
  type PolicyView,
  type ToolCall,
} from './evaluate.js';

const forcePush: PolicyRule = {
  id: 'g@1:no-force-push',
  kind: 'command',
  decision: 'forbid',
  reason: 'A force-push rewrites shared history.',
  required: false,
  executable: 'git',
  argv_prefix: ['push'],
  flags_any: ['--force', '-f'],
};
const vault: PolicyRule = {
  id: 'g@1:no-vault',
  kind: 'path',
  decision: 'forbid',
  reason: 'Credentials stay in the vault.',
  required: true,
  access: 'any',
  glob: 'vault/**',
};
const noWrite: PolicyRule = { ...vault, id: 'g@1:no-dist-write', access: 'write', glob: 'dist' };
const askFirst: PolicyRule = {
  ...forcePush,
  id: 'g@1:ask-rm',
  decision: 'ask',
  executable: 'rm',
  argv_prefix: [],
  flags_any: ['-rf'],
};

let root: string;
let home: string;
const roots = () => ({ project: root, home, ror: join(home, '.runonroad') });
const policy = (...rules: PolicyRule[]): PolicyView => ({ rules, mcp_allow: ['docs'] });
const bash = (command: string, cwd = root): ToolCall => ({
  tool_name: 'Bash',
  tool_input: { command },
  cwd,
});
const tool = (tool_name: string, tool_input: Record<string, unknown>, cwd = root): ToolCall => ({
  tool_name,
  tool_input,
  cwd,
});
const run = (view: PolicyView, call: ToolCall) =>
  evaluate(view, call, { project: root, home, ror: join(home, '.runonroad') });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ror-eval-'));
  home = mkdtempSync(join(tmpdir(), 'ror-evalhome-'));
  mkdirSync(join(root, 'vault'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'vault', 'item.txt'), 'TOPSECRET');
  writeFileSync(join(root, 'ok.txt'), 'fine');
  symlinkSync(join(root, 'vault', 'item.txt'), join(root, 'innocent.txt'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('a command rule', () => {
  const view = policy(forcePush);
  const denied = [
    'git push --force origin main',
    'git push -f',
    'git push origin main --force',
    'git -C repo push --force',
    'git push -uf origin main',
    'env GIT_TRACE=1 git push -f',
    'sudo git push --force',
    '/usr/bin/git push --force',
    'git status && git push -f',
    'echo ok; git push --force',
    'sh -c "git push --force"',
    "bash -lc 'cd x && git push -f'",
    'echo $(git push -f)',
    'xargs git push --force < list',
    'FORCE=1 git push --force',
  ];
  const allowed = [
    'git push origin main',
    'git push --force-with-lease',
    'git status',
    'git pull --force',
    'git stash push',
    'echo hello',
    'ls -f',
  ];
  it.each(denied)('refuses %s', (command) => {
    expect(run(view, bash(command))).toMatchObject({ allow: false, rule: forcePush.id });
  });
  it.each(allowed)('lets %s through', (command) => {
    expect(run(view, bash(command))).toEqual({ allow: true });
  });
  it('names the rule and gives its reason', () => {
    expect(run(view, bash('git push -f'))).toEqual({
      allow: false,
      rule: forcePush.id,
      reason: forcePush.reason,
    });
  });
});

describe('a glob written with Windows separators', () => {
  // `join` makes `C:\\proj\\vault\\**` on Windows: the tail must still be cut, so the folder itself is in the rule
  it('covers the folder and what is below it', () => {
    const pattern = globToRegExp('C:\\proj\\vault\\**', 'win32');
    for (const path of ['c:/proj/vault', 'c:/proj/vault/item.txt', 'c:/proj/vault/a/b']) {
      expect(pattern.test(path), path).toBe(true);
    }
    expect(pattern.test('c:/proj/vaulted'), 'a sibling').toBe(false);
    expect(pattern.test('c:/proj/other/vault'), 'elsewhere').toBe(false);
  });
});

describe('a project reached through a link', () => {
  // macOS: the temp folder `/var/...` is `/private/var/...`; a linked workspace is the same
  it('keeps its vault under the link spelling and under the real one', () => {
    const real = mkdtempSync(join(tmpdir(), 'ror-evalreal-'));
    const linked = join(tmpdir(), `ror-evallink-${String(Date.now())}`);
    mkdirSync(join(real, 'vault'));
    writeFileSync(join(real, 'vault', 'item.txt'), 'TOPSECRET');
    symlinkSync(real, linked);
    try {
      const view = policy(vault);
      const asked = (file: string, project: string) =>
        evaluate(
          view,
          { tool_name: 'Read', tool_input: { file_path: file }, cwd: project },
          { project, home, ror: join(home, '.runonroad') },
        );
      for (const project of [linked, real]) {
        for (const file of [join(linked, 'vault', 'item.txt'), join(real, 'vault', 'item.txt')]) {
          expect(asked(file, project), `${project} ${file}`).toMatchObject({ allow: false });
        }
      }
    } finally {
      rmSync(linked, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('a path rule', () => {
  const view = policy(vault, noWrite);
  it('refuses the built-in tools, in every spelling of the path', () => {
    for (const path of [
      'vault/item.txt',
      './vault/item.txt',
      join(root, 'vault', 'item.txt'),
      'vault/../vault/item.txt',
      'vault/new-file.txt',
      'innocent.txt',
    ]) {
      expect(run(view, tool('Read', { file_path: path })), path).toMatchObject({ allow: false });
    }
    expect(run(view, tool('Edit', { file_path: 'vault/item.txt' }))).toMatchObject({
      allow: false,
    });
    expect(run(view, tool('Grep', { pattern: 'x', path: 'vault' }))).toMatchObject({
      allow: false,
    });
  });
  it('resolves the path from the working directory the call says', () => {
    expect(run(view, tool('Read', { file_path: 'item.txt' }, join(root, 'vault')))).toMatchObject({
      allow: false,
    });
    expect(run(view, tool('Grep', { pattern: 'x' }, join(root, 'vault')))).toMatchObject({
      allow: false,
    });
  });
  it('lets the rest of the project alone', () => {
    expect(run(view, tool('Read', { file_path: 'ok.txt' }))).toEqual({ allow: true });
    expect(run(view, tool('Read', { file_path: 'vault-not' }))).toEqual({ allow: true });
  });
  it('honours the access: a write-only rule leaves reading free', () => {
    expect(run(view, tool('Read', { file_path: 'dist/app.js' }))).toEqual({ allow: true });
    expect(run(view, tool('Write', { file_path: 'dist/app.js', content: 'x' }))).toMatchObject({
      allow: false,
    });
  });
  it.each([
    'cat vault/item.txt',
    'cat < vault/item.txt',
    'echo hi > vault/new.txt',
    'cd vault && cat item.txt',
    'cat vault/../vault/item.txt',
    'sh -c "cat vault/item.txt"',
    'cat innocent.txt',
    'ls $(echo vault/)',
  ])('refuses the shell command %s', (command) => {
    expect(run(view, bash(command))).toMatchObject({ allow: false });
  });
  it('refuses an absolute path inside quotes', () => {
    expect(run(view, bash(`cat "${join(root, 'vault', 'item.txt')}"`))).toMatchObject({
      allow: false,
    });
  });
  it('lets harmless shell commands through', () => {
    expect(run(view, bash('cat ok.txt && ls'))).toEqual({ allow: true });
  });
  it('expands ~ against the home directory it is given', () => {
    const homeRule: PolicyRule = { ...vault, id: 'g@1:no-keys', glob: '~/.keys/**' };
    expect(run(policy(homeRule), bash('cat ~/.keys/main'))).toMatchObject({ allow: false });
  });
});

describe('an Ask-first rule', () => {
  it('denies: there is no derogation to lift it yet', () => {
    const verdict = run(policy(askFirst), bash('rm -rf build'));
    expect(verdict).toMatchObject({ allow: false, rule: askFirst.id });
    expect(verdict.allow ? '' : verdict.reason).toContain(`ror derogation request ${askFirst.id}`);
  });
});

describe('the other surfaces', () => {
  const view = policy(vault);
  it('denies an MCP server that is not allowed, and lets an allowed one in', () => {
    expect(run(view, tool('mcp__files__read', {}))).toMatchObject({ allow: false });
    expect(run(view, tool('mcp__docs__search', {}))).toEqual({ allow: true });
  });
  it('denies a tool it does not know rather than guessing', () => {
    expect(run(view, tool('BrandNewTool', {}))).toMatchObject({ allow: false });
  });
  it('lets the tools without effect through', () => {
    for (const name of ['TodoWrite', 'WebFetch', 'Agent', 'AskUserQuestion']) {
      expect(run(view, tool(name, {})), name).toEqual({ allow: true });
    }
  });
  it('refuses a call it cannot read', () => {
    expect(run(view, tool('Bash', {}))).toMatchObject({ allow: false });
    expect(run(view, tool('Edit', {}))).toMatchObject({ allow: false });
  });
});

describe('without a usable policy', () => {
  it('allows reading and nothing that acts', () => {
    expect(evaluateWithoutPolicy(tool('Read', { file_path: 'a' }), 'expired', roots())).toEqual({
      allow: true,
    });
    for (const name of ['Bash', 'Edit', 'Write', 'mcp__x__y', 'Weird']) {
      expect(evaluateWithoutPolicy(tool(name, {}), 'expired', roots()), name).toMatchObject({
        allow: false,
      });
    }
  });
});
