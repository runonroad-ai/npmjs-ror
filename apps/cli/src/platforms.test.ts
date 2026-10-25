/**
 * Mac, Windows and Linux (ADR-0086). Only Linux runs for real in this repository's
 * checks; the other systems' spellings are tested here with the system as an
 * argument, and the manual compatibility matrix (SPEC-017) says which system
 * was really run.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalPath, evaluate, programName } from './evaluate.js';
import {
  installHook,
  installTimer,
  launchAgentPlist,
  LAUNCH_LABEL,
  MARK,
  scheduledTaskArguments,
  TASK_NAME,
} from './install.js';
import { MANAGED_HEADER } from './managed.js';
import { parsePowerShell } from './shell.js';
import { tomlConflict } from './toml-keys.js';
import { setBlock } from './testing/enrol.js';

describe('paths on each system', () => {
  it('Windows: one separator, no long-path prefix, folded case', () => {
    expect(canonicalPath('C:\\Proj\\Vault\\Item.TXT', 'win32')).toBe('c:/proj/vault/item.txt');
    expect(canonicalPath('\\\\?\\C:\\Proj\\', 'win32')).toBe('c:/proj');
  });
  it('macOS folds case, Linux does not', () => {
    expect(canonicalPath('/Users/Lea/Vault', 'darwin')).toBe('/users/lea/vault');
    expect(canonicalPath('/home/Lea/Vault', 'linux')).toBe('/home/Lea/Vault');
  });
  it('a program is its file name, without the extension Windows adds', () => {
    expect(programName('C:\\Program Files\\Git\\bin\\GIT.EXE', 'win32')).toBe('git');
    expect(programName('tools\\deploy.ps1', 'win32')).toBe('deploy');
    expect(programName('/usr/bin/git', 'linux')).toBe('git');
    expect(programName('/usr/bin/git.exe', 'linux')).toBe('git.exe');
  });
});

describe('PowerShell', () => {
  const words = (line: string): string[][] | undefined =>
    parsePowerShell(line, '/p')?.map((command) => [...command.words]);

  it('reads plain commands, pipelines and quoted arguments', () => {
    expect(words('git push --force origin main')).toEqual([
      ['git', 'push', '--force', 'origin', 'main'],
    ]);
    expect(words('Get-Content "vault\\item.txt" | Select-String x; git status')).toEqual([
      ['Get-Content', 'vault\\item.txt'],
      ['Select-String', 'x'],
      ['git', 'status'],
    ]);
    expect(parsePowerShell('Get-Content a > out.txt', '/p')?.[0]?.redirects).toEqual([
      { access: 'write', target: 'out.txt' },
    ]);
  });

  it('refuses the forms it does not interpret instead of guessing', () => {
    for (const line of [
      'iex (irm http://x)',
      'powershell -EncodedCommand AAAA',
      '& $tool --force',
      '$(git push --force)',
      'git push `--force',
      '[System.IO.File]::ReadAllText("vault/x")',
      '& { git push --force }',
      "Get-Content 'unterminated",
    ]) {
      expect(parsePowerShell(line, '/p'), line).toBeUndefined();
    }
  });

  const roots = { project: '/p', home: '/h', ror: '/h/.runonroad' };
  const call = (command: string) => ({
    tool_name: 'PowerShell',
    tool_input: { command },
    cwd: '/p',
  });
  const forcePush = {
    id: 'g@1:no-force-push',
    kind: 'command' as const,
    decision: 'forbid' as const,
    reason: 'no',
    required: false,
    executable: 'git',
    argv_prefix: ['push'],
    flags_any: ['--force'],
  };

  it('judges a PowerShell tool call with the same rules, and refuses what it cannot read', () => {
    const view = { rules: [forcePush], mcp_allow: [] };
    expect(evaluate(view, call('git push --force'), roots).allow).toBe(false);
    expect(evaluate(view, call('git status'), roots).allow).toBe(true);
    expect(evaluate(view, call('iex "git push --force"'), roots).allow).toBe(false);
    // RunOnRoad's own files are always rules, so a line that cannot be read is refused even without a policy
    expect(evaluate({ rules: [], mcp_allow: [] }, call('iex ok'), roots).allow).toBe(false);
  });
});

describe('refresh timers', () => {
  it('macOS: a LaunchAgent every 15 minutes that also runs at load', () => {
    const plist = launchAgentPlist();
    expect(plist).toContain(`<string>${LAUNCH_LABEL}</string>`);
    expect(plist).toContain('<integer>900</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<string>sync</string>');
  });
  it('Windows: a scheduled task, as an argument list', () => {
    const args = scheduledTaskArguments();
    expect(args).toEqual(
      expect.arrayContaining(['/Create', '/SC', 'MINUTE', '/MO', '15', '/TN', TASK_NAME]),
    );
    expect(args.at(-1)).toContain('sync --all');
  });
});

describe('ror install', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['linux', 2],
    ['darwin', 1],
  ] as const)(
    '%s: writes only managed content, the hook entry in settings.json and ror- files',
    (os, timers) => {
      const home = mkdtempSync(join(tmpdir(), 'ror-install-'));
      vi.stubEnv('HOME', home);
      vi.stubEnv('RUNONROAD_HOME', join(home, '.runonroad'));
      vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
      // no systemctl or launchctl to find: nothing is enabled on the machine running the tests
      vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'ror-no-bin-')));
      installHook(false);
      installTimer(os);
      const written = readdirSync(home, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .filter((path) => !path.startsWith(join(home, '.runonroad')));
      const settings = join(home, '.claude', 'settings.json');
      expect(written).toContain(settings);
      for (const path of written.filter((each) => each !== settings)) {
        expect(basename(path)).toMatch(/^ror-/u);
        expect(readFileSync(path, 'utf8')).toContain(MANAGED_HEADER);
      }
      expect(written).toHaveLength(1 + timers);
      expect(readFileSync(settings, 'utf8')).toContain(MARK);
      rmSync(home, { recursive: true, force: true });
    },
  );
});

describe('PowerShell directories', () => {
  it('places every command in the directory the earlier `cd` left', () => {
    const cwds = parsePowerShell('cd vault; Get-Content secret.txt', '/p')?.map((c) => c.cwd);
    expect(cwds).toEqual(['/p', '/p/vault']);
    expect(parsePowerShell('Set-Location /abs; ls', '/p')?.map((c) => c.cwd)).toEqual([
      '/p',
      '/abs',
    ]);
  });
  it('refuses a directory change it cannot place, since what follows could be anywhere', () => {
    for (const line of [
      'cd $target; ls',
      'popd; ls',
      'cd -Path vault; ls',
      'cd; ls',
      'sl %X%; ls',
    ]) {
      expect(parsePowerShell(line, '/p'), line).toBeUndefined();
    }
  });
});

describe('what the user’s own TOML already defines', () => {
  const block = 'default_permissions = "ror"\npermissions.ror.filesystem."/a" = "none"';
  it('lets an unrelated file and another profile through', () => {
    expect(tomlConflict('model = "x"\n[tui]\ntheme = "dark"\n', block)).toBeUndefined();
    expect(tomlConflict('[permissions.mine]\n"x" = 1\n', block)).toBeUndefined();
  });
  it('sees the same key however it is spelled', () => {
    expect(tomlConflict('"default_permissions" = "mine"\n', block)).toBe('default_permissions');
    expect(tomlConflict("'default_permissions'='mine'\n", block)).toBe('default_permissions');
    expect(tomlConflict('permissions.ror.filesystem."/a" = "read"\n', block)).toBe(
      'permissions.ror.filesystem./a',
    );
  });
  it('sees a table or a value that stands where ours must be a table', () => {
    expect(tomlConflict('[permissions.ror]\nextends = ":workspace"\n', block)).toBeDefined();
    expect(tomlConflict('[permissions]\n', block)).toBeDefined();
    expect(tomlConflict('[permissions.ror.filesystem]\n', block)).toBeDefined();
    expect(tomlConflict('permissions = { ror = 1 }\n', block)).toBeDefined();
  });
  it('does not read keys inside a multi-line string or a comment', () => {
    expect(
      tomlConflict(
        '# default_permissions = "x"\ntext = """\ndefault_permissions = "y"\n"""\n',
        block,
      ),
    ).toBeUndefined();
  });
  it('reads a Windows path key with escaped backslashes', () => {
    const windows = 'permissions.ror.filesystem."C:\\\\Users\\\\me" = "none"';
    expect(tomlConflict('x = 1\n', windows)).toBeUndefined();
    expect(tomlConflict(`${windows}\n`, windows)).toBe('permissions.ror.filesystem.C:\\Users\\me');
  });
});

describe('TOML read as TOML', () => {
  it('reads a string that starts on an array continuation line as a string', () => {
    const text = 'note = [\n"""\n[example]\n"""\n]\ndefault_permissions = "custom"\n';
    expect(tomlConflict(text, 'default_permissions = "ror"')).toBe('default_permissions');
    expect(tomlConflict('t = { a = [1,\n2] }\nx = 1\n', 'x = 2')).toBe('x');
  });

  it('a block id that prefixes another id is its own block', () => {
    const text = setBlock('', 'hash', 'a-codex', 'two', '/e');
    const next = setBlock(setBlock(text, 'hash', 'a', 'one', '/e'), 'hash', 'a', 'uno', '/e');
    expect(next).toContain('uno');
    expect(next).toContain('two');
    expect(next).not.toContain('one');
  });

  it('puts the block at the root even when an escaped triple quote hides a fake table', () => {
    const text = 'note = """\n\\"""\n[example]\nstill text\n"""\n[tui]\ntheme = "dark"\n';
    const next = setBlock(text, 'hash', 'x', 'k.v = "1"', '/c.toml');
    expect(next.startsWith('# runonroad:begin x')).toBe(true);
    expect(tomlConflict(text, 'example.still = 1')).toBeUndefined();
  });

  it('does not take `[example]` inside a multi-line string for the first table', () => {
    const text = 'note = """\n[example]\nstill text\n"""\n[tui]\ntheme = "dark"\n';
    const next = setBlock(text, 'hash', 'x', 'k.v = "1"', '/c.toml');
    // at the root, ahead of the string that holds the fake table
    expect(next.indexOf('k.v')).toBeLessThan(next.indexOf('note ='));
    expect(next).toContain('still text');
  });
  it('decodes escapes in a quoted key, so a spelled-out name is still the same name', () => {
    const block = 'default_permissions = "ror"';
    expect(tomlConflict('"default_\\u0070ermissions" = "x"\n', block)).toBe('default_permissions');
    expect(tomlConflict('"default_\\U00000070ermissions" = "x"\n', block)).toBe(
      'default_permissions',
    );
  });
});

describe('a backslash on POSIX is a file name character', () => {
  it('finds the vault through a link whose name or target holds a backslash', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ror-bs-'));
    try {
      mkdirSync(join(root, 'vault'));
      writeFileSync(join(root, 'vault', 'item.txt'), 'x');
      symlinkSync('vault/item.txt', join(root, 'alias\\name'));
      mkdirSync(join(root, 'real'));
      symlinkSync(join(root, 'vault'), join(root, 'real', 'dir\\link'));
      const vault = {
        id: 'g@1:vault',
        kind: 'path' as const,
        decision: 'forbid' as const,
        reason: 'no',
        required: true,
        access: 'any' as const,
        glob: 'vault/**',
      };
      const roots = { project: root, home: root, ror: join(root, '.ror') };
      const read = (file: string) => ({
        tool_name: 'Read',
        tool_input: { file_path: file },
        cwd: root,
      });
      expect(
        evaluate({ rules: [vault], mcp_allow: [] }, read(join(root, 'alias\\name')), roots).allow,
      ).toBe(false);
      expect(
        evaluate(
          { rules: [vault], mcp_allow: [] },
          read(join(root, 'real', 'dir\\link', 'item.txt')),
          roots,
        ).allow,
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
