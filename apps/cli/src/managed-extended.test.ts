// ADR-0119: what the managed writer executes when the caller asks for the extended operations
// (ensure_dir, merge_json), the placement of top-level TOML, the retirement of what an earlier apply
// wrote, the drift read, and the compatibility of the lock with the writer of staging.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ContractOperation } from '@runonroad/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as managed from './managed.js';

let base: string;
const at = (path: string) => join(base, 'project', path);
const read = (path: string) => fs.readFileSync(at(path), 'utf8');
const layer = (): managed.Layer => ({
  roots: { project: at('') },
  lockPath: at('.runonroad/lock/claude_code.json'),
});
const lock = () => managed.readLock(layer().lockPath);
const apply = (operations: ContractOperation[], options: managed.ApplyOptions = {}) =>
  managed.applyManaged(operations, layer(), { extended: true, ...options });
const json = (
  pointer: string,
  value: unknown,
  strategy: 'set' | 'append_unique' = 'set',
  path = '${project}/.claude/settings.local.json',
): ContractOperation => ({ op: 'merge_json', path, pointer, value, strategy, owner: '_runonroad' });
const toml = (content: string, blockId = 'ror-codex'): ContractOperation => ({
  op: 'managed_block',
  path: '${project}/config.toml',
  block_id: blockId,
  content,
  comment_style: 'hash',
});

beforeEach(() => {
  base = fs.mkdtempSync(join(tmpdir(), 'ror-managed-ext-'));
  fs.mkdirSync(at(''));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the extended operations are opt-in', () => {
  it('refuses merge_json and ensure_dir without the option, before any write', () => {
    for (const operation of [json('/a', 1), { op: 'ensure_dir' as const, path: '${project}/d' }]) {
      expect(() => {
        managed.applyManaged([operation], layer());
      }).toThrow(managed.UnsupportedOperationError);
    }
    expect(fs.readdirSync(at(''))).toEqual([]);
  });
});

describe('merge_json', () => {
  it('sets a value, keeps the rest, and the retirement gives back what was there', () => {
    fs.mkdirSync(at('.claude'));
    fs.writeFileSync(
      at('.claude/settings.local.json'),
      JSON.stringify({ permissions: { allow: ['x'] }, mode: 'old' }),
    );
    apply([json('/mode', 'new'), json('/permissions/disableBypass', 'disable')]);
    expect(JSON.parse(read('.claude/settings.local.json'))).toEqual({
      permissions: { allow: ['x'], disableBypass: 'disable' },
      mode: 'new',
    });
    const entry = lock().entries.find((item) => item.pointer === '/mode');
    expect(entry).toMatchObject({
      kind: 'json',
      block_id: 'json:/mode',
      had_previous: true,
      previous: 'old',
    });
    const retired = apply([], { retire: 'unchanged-only' });
    expect(retired.removed).toHaveLength(2);
    expect(JSON.parse(read('.claude/settings.local.json'))).toEqual({
      permissions: { allow: ['x'] },
      mode: 'old',
    });
    expect(lock().entries).toEqual([]);
  });

  it('appends unique elements, takes back only its own, and removes a file and a list it created', () => {
    apply([json('/permissions/deny', ['a', 'b'], 'append_unique')]);
    expect(JSON.parse(read('.claude/settings.local.json'))).toEqual({
      permissions: { deny: ['a', 'b'] },
    });
    // the next bundle asks for b and c: a is taken back, b stays, c is added
    apply([json('/permissions/deny', ['b', 'c'], 'append_unique')], { retire: 'unchanged-only' });
    expect(JSON.parse(read('.claude/settings.local.json'))).toEqual({
      permissions: { deny: ['b', 'c'] },
    });
    apply([], { retire: 'unchanged-only' });
    expect(fs.existsSync(at('.claude/settings.local.json'))).toBe(false);
  });

  it('leaves an element the owner already had, and a list that was there', () => {
    fs.mkdirSync(at('.claude'));
    fs.writeFileSync(
      at('.claude/settings.local.json'),
      JSON.stringify({ permissions: { deny: ['mine'] } }),
    );
    apply([json('/permissions/deny', ['mine', 'ours'], 'append_unique')]);
    expect(lock().entries[0]?.values).toEqual(['ours']);
    apply([], { retire: 'unchanged-only' });
    expect(JSON.parse(read('.claude/settings.local.json'))).toEqual({
      permissions: { deny: ['mine'] },
    });
  });

  it('keeps what a person changed since: still owned, still in the lock, never destroyed', () => {
    apply([json('/mode', 'ror')]);
    fs.writeFileSync(at('.claude/settings.local.json'), JSON.stringify({ mode: 'hand' }));
    const result = apply([], { retire: 'unchanged-only' });
    expect(result.kept).toEqual(['${project}/.claude/settings.local.json']);
    expect(read('.claude/settings.local.json')).toContain('hand');
    expect(lock().entries).toHaveLength(1);
    expect(managed.driftOf(layer())).toEqual(['${project}/.claude/settings.local.json']);
  });

  it('refuses pointers that reach the prototype, bad escapes, empty segments and walks through lists', () => {
    for (const pointer of ['/__proto__/x', '/constructor', '/a~2b', '/a//b', '', 'a']) {
      expect(() => {
        apply([json(pointer, 1)]);
      }, pointer).toThrow(managed.RefusedOperationError);
    }
    fs.mkdirSync(at('.claude'));
    fs.writeFileSync(at('.claude/settings.local.json'), JSON.stringify({ a: [1] }));
    expect(() => {
      apply([json('/a/0', 2)]);
    }).toThrow(managed.RefusedOperationError);
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });

  it('refuses a file that is not a JSON object, a JSONC file, and a path that is not .json', () => {
    fs.mkdirSync(at('.claude'));
    for (const text of ['[1]', '// comment\n{}', '{"a":']) {
      fs.writeFileSync(at('.claude/settings.local.json'), text);
      expect(() => {
        apply([json('/a', 1)]);
      }, text).toThrow(managed.RefusedOperationError);
      expect(read('.claude/settings.local.json')).toBe(text);
    }
    expect(() => {
      apply([json('/a', 1, 'set', '${project}/x.txt')]);
    }).toThrow(managed.RefusedOperationError);
    expect(() => {
      apply([{ ...json('/a', 1), strategy: 'remove' } as ContractOperation]);
    }).toThrow(managed.RefusedOperationError);
  });

  it('refuses two pointers of one file when one holds the other', () => {
    expect(() => {
      apply([json('/a', {}), json('/a/b', 1)]);
    }).toThrow(managed.RefusedOperationError);
    expect(fs.existsSync(at('.claude/settings.local.json'))).toBe(false);
  });

  it('does not write the lock or the file when a later operation is refused', () => {
    expect(() => {
      apply([json('/a', 1), json('/__proto__', 1)]);
    }).toThrow(managed.RefusedOperationError);
    expect(fs.existsSync(at('.claude/settings.local.json'))).toBe(false);
    expect(fs.existsSync(layer().lockPath)).toBe(false);
  });

  it('picks up an interrupted apply: the first lock tells what was there before', () => {
    fs.mkdirSync(at('.claude'));
    fs.writeFileSync(at('.claude/settings.local.json'), JSON.stringify({ mode: 'old' }));
    // the first apply wrote the file, then stopped before the final lock: only the intent lock is there
    const intent = {
      version: 1,
      entries: [
        {
          path: '${project}/.claude/settings.local.json',
          block_id: 'json:/mode',
          kind: 'json',
          pointer: '/mode',
          strategy: 'set',
          sha256: 'sha256:x',
          values: ['ror'],
          had_previous: true,
          previous: 'old',
          pending: true,
        },
      ],
    };
    fs.mkdirSync(at('.runonroad/lock'), { recursive: true });
    fs.writeFileSync(layer().lockPath, JSON.stringify(intent));
    fs.writeFileSync(at('.claude/settings.local.json'), JSON.stringify({ mode: 'ror' }));
    apply([json('/mode', 'ror')]);
    const entry = lock().entries[0];
    expect(entry).toMatchObject({ had_previous: true, previous: 'old' });
    expect(entry).not.toHaveProperty('pending');
    apply([], { retire: 'unchanged-only' });
    expect(JSON.parse(read('.claude/settings.local.json'))).toEqual({ mode: 'old' });
  });
});

describe('the lock and the writer of staging', () => {
  it('survives an apply without the option, and a bundle cannot remove it by a reserved id', () => {
    apply([json('/mode', 'ror'), { op: 'ensure_dir', path: '${project}/made/deep' }]);
    const before = lock().entries;
    managed.applyManaged(
      [{ op: 'write_file', path: '${project}/ror-a.md', content: 'Managed by RunOnRoad\n' }],
      layer(),
    );
    expect(lock().entries.filter((entry) => entry.kind !== undefined)).toEqual(
      before.filter((entry) => entry.kind !== undefined),
    );
    expect(() => {
      managed.applyManaged(
        [
          {
            op: 'remove_managed',
            path: '${project}/.claude/settings.local.json',
            block_id: 'json:/mode',
          },
        ],
        layer(),
      );
    }).toThrow(managed.RefusedOperationError);
    // and the file as a whole is not claimed by a write_file: it is not a ror- file nor locked as one
    expect(() => {
      managed.applyManaged(
        [
          {
            op: 'write_file',
            path: '${project}/.claude/settings.local.json',
            content: 'Managed by RunOnRoad',
          },
        ],
        layer(),
      );
    }).toThrow(managed.RefusedOperationError);
  });
});

describe('ensure_dir', () => {
  it('records the folders it creates, not the ones that were there, and retires the empty ones', () => {
    fs.mkdirSync(at('there'));
    apply([
      { op: 'ensure_dir', path: '${project}/there/new/deep' },
      { op: 'ensure_dir', path: '${project}/there' },
    ]);
    expect(fs.statSync(at('there/new/deep')).isDirectory()).toBe(true);
    expect(lock().entries.map((entry) => entry.path)).toEqual([
      '${project}/there/new',
      '${project}/there/new/deep',
    ]);
    fs.writeFileSync(at('there/new/deep/mine.txt'), 'x');
    const kept = apply([], { retire: 'unchanged-only' });
    expect(kept.kept).toHaveLength(2);
    fs.rmSync(at('there/new/deep/mine.txt'));
    apply([], { retire: 'unchanged-only' });
    expect(fs.existsSync(at('there/new'))).toBe(false);
    expect(fs.existsSync(at('there'))).toBe(true);
  });

  it('refuses a path that is a file, and escapes', () => {
    fs.writeFileSync(at('file'), 'x');
    expect(() => {
      apply([{ op: 'ensure_dir', path: '${project}/file/sub' }]);
    }).toThrow(managed.RefusedOperationError);
    expect(() => {
      apply([{ op: 'ensure_dir', path: '${project}/../out' }]);
    }).toThrow(managed.RefusedOperationError);
  });
});

describe('retirement of files and blocks, drift and uninstall', () => {
  const header = 'Managed by RunOnRoad\n';
  const file = (name: string, content = header): ContractOperation => ({
    op: 'write_file',
    path: `\${project}/ror-${name}.md`,
    content,
  });

  it('retires a stale file that is unchanged and keeps one a person edited', () => {
    apply([file('a'), file('b')]);
    fs.appendFileSync(at('ror-b.md'), 'mine');
    const result = apply([], { retire: 'unchanged-only' });
    expect(result.removed).toEqual([at('ror-a.md')].map(() => '${project}/ror-a.md'));
    expect(result.kept).toEqual(['${project}/ror-b.md']);
    expect(fs.existsSync(at('ror-a.md'))).toBe(false);
    expect(fs.existsSync(at('ror-b.md'))).toBe(true);
    expect(managed.driftOf(layer())).toEqual(['${project}/ror-b.md']);
  });

  it('uninstalls what is unchanged and drops the lock when nothing is left', () => {
    fs.writeFileSync(at('AGENTS.md'), 'mine\n');
    apply([
      file('a'),
      {
        op: 'managed_block',
        path: '${project}/AGENTS.md',
        block_id: 'ror-governance',
        content: 'rules',
        comment_style: 'hash',
      },
      json('/mode', 'ror'),
    ]);
    const result = managed.uninstallManaged(layer());
    expect(result.kept).toEqual([]);
    expect(read('AGENTS.md')).toBe('mine\n');
    expect(fs.existsSync(layer().lockPath)).toBe(false);
    expect(fs.existsSync(at('ror-a.md'))).toBe(false);
    expect(fs.existsSync(at('.claude/settings.local.json'))).toBe(false);
  });

  it('reports what changed and what stayed the same', () => {
    expect(apply([file('a')]).written).toHaveLength(1);
    const again = apply([file('a')]);
    expect(again.written).toEqual([]);
    expect(again.unchanged).toBe(1);
  });
});

describe('top-level TOML keys (ADR-0119 point 3 bis)', () => {
  it('goes first on the first insertion, ahead of the tables of the person', () => {
    fs.writeFileSync(at('config.toml'), '[model]\nname = "x"\n');
    apply([toml('default_permissions = "ror"')]);
    expect(read('config.toml')).toBe(
      '# runonroad:begin ror-codex\ndefault_permissions = "ror"\n# runonroad:end ror-codex\n\n[model]\nname = "x"\n',
    );
    apply([toml('default_permissions = "ror2"')]);
    expect(read('config.toml')).toContain('default_permissions = "ror2"');
    expect(read('config.toml').indexOf('[model]')).toBeGreaterThan(
      read('config.toml').indexOf('ror2'),
    );
  });

  it('refuses a key or a parent table the person already defines, and writes nothing', () => {
    for (const mine of ['default_permissions = "mine"\n', '[permissions]\nx = 1\n']) {
      fs.writeFileSync(at('config.toml'), mine);
      expect(() => {
        apply([toml('default_permissions = "ror"\npermissions.ror.extends = ":workspace"')]);
      }, mine).toThrow(managed.RefusedOperationError);
      expect(read('config.toml')).toBe(mine);
    }
  });

  it('adds a block that starts with a table header at the end, as before', () => {
    fs.writeFileSync(at('config.toml'), 'a = 1\n');
    apply([toml('[ror]\nx = 1')]);
    expect(read('config.toml').endsWith('# runonroad:end ror-codex\n')).toBe(true);
    expect(read('config.toml').startsWith('a = 1\n')).toBe(true);
  });
});
