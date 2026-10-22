import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ContractOperation } from '@runonroad/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as managed from './managed.js';

const VECTORS = fileURLToPath(
  new URL('../../../packages/api-contract/vectors/operations/', import.meta.url),
);
const vector = (name: string) =>
  (JSON.parse(fs.readFileSync(join(VECTORS, name), 'utf8')) as { operations: ContractOperation[] })
    .operations;
const sha256 = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

let base: string;
const at = (path: string) => join(base, 'project', path);
const read = (path: string) => fs.readFileSync(at(path), 'utf8');
const lock = () => managed.readLock(at('.runonroad/lock/claude_code.json')).entries;
const apply = (...operations: ContractOperation[]) => {
  managed.applyManaged(operations, {
    roots: { project: at('') },
    lockPath: at('.runonroad/lock/claude_code.json'),
  });
};
const block = (content: string, blockId = 'ror-governance'): ContractOperation => ({
  op: 'managed_block',
  path: '${project}/AGENTS.md',
  block_id: blockId,
  content,
  comment_style: 'hash',
});

beforeEach(() => {
  base = fs.mkdtempSync(join(tmpdir(), 'ror-managed-'));
  fs.mkdirSync(at(''));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the api-contract vectors', () => {
  it('applies valid--write-file* and valid--managed-block, each write in the lock with its hash', () => {
    const files = [
      ...vector('valid--write-file.json'),
      ...vector('valid--write-file-executable.json'),
    ];
    apply(...files, ...vector('valid--managed-block.json'));
    for (const file of files) {
      if (file.op !== 'write_file') throw new Error('write_file expected');
      expect(read(file.path.replace('${project}/', ''))).toBe(file.content);
      expect(lock()).toContainEqual({ path: file.path, sha256: sha256(file.content) });
    }
    expect(fs.statSync(at('.claude/hooks/ror-check.sh')).mode & 0o111).not.toBe(0);
    expect(read('AGENTS.md')).toBe(
      '<!-- runonroad:begin ror-governance -->\nFollow the governance.\n<!-- runonroad:end ror-governance -->\n',
    );
  });

  it('applies valid--remove-managed-*: the content and its lock entry go', () => {
    apply(
      { op: 'write_file', path: '${project}/.claude/rules/ror-old.md', content: 'old\n' },
      block('old', 'ror-old'),
    );
    fs.writeFileSync(at('AGENTS.md'), `mine\n${read('AGENTS.md')}`);
    apply(
      ...vector('valid--remove-managed-by-path.json'),
      ...vector('valid--remove-managed-by-block-id.json'),
    );
    expect(fs.existsSync(at('.claude/rules/ror-old.md'))).toBe(false);
    expect(read('AGENTS.md')).toBe('mine\n');
    expect(lock()).toEqual([]);
  });

  it('refuses the six device--write-file-* vectors and writes nothing', () => {
    const refused = fs
      .readdirSync(VECTORS)
      .filter((file) => file.startsWith('device--write-file-'));
    expect(refused).toHaveLength(6);
    for (const file of refused) {
      expect(() => {
        apply(...vector(file));
      }, file).toThrow(managed.RefusedOperationError);
    }
    expect(fs.readdirSync(at(''))).toEqual([]);
  });
});

describe('what RunOnRoad does not manage', () => {
  it('refuses a file neither ror- prefixed nor in the lock, or ror- without the header, unchanged', () => {
    for (const name of ['notes.md', 'ror-mine.md']) {
      fs.writeFileSync(at(name), 'mine\n');
      expect(() => {
        apply({ op: 'write_file', path: `\${project}/${name}`, content: 'x' });
      }, name).toThrow(managed.RefusedOperationError);
      expect(read(name)).toBe('mine\n');
    }
    expect(fs.readdirSync(at(''))).toEqual(['notes.md', 'ror-mine.md']);
  });

  it('refuses a file not ror- prefixed and not in the lock, new or carrying the header', () => {
    fs.writeFileSync(at('headed.md'), '# Managed by RunOnRoad\nmine\n');
    for (const name of ['new.md', 'headed.md']) {
      expect(() => {
        apply({ op: 'write_file', path: `\${project}/${name}`, content: 'x' });
      }, name).toThrow(managed.RefusedOperationError);
    }
    expect(fs.readdirSync(at(''))).toEqual(['headed.md']);
    expect(read('headed.md')).toBe('# Managed by RunOnRoad\nmine\n');
  });

  it('refuses a write_file onto a file the lock holds only a block of', () => {
    fs.writeFileSync(at('AGENTS.md'), 'mine\n');
    apply(block('one'));
    const before = read('AGENTS.md');
    expect(() => {
      apply({ op: 'write_file', path: '${project}/AGENTS.md', content: 'x' });
    }).toThrow(managed.RefusedOperationError);
    expect(read('AGENTS.md')).toBe(before);
  });

  it('refuses a user file without the header under a ror- folder', () => {
    fs.mkdirSync(at('ror-dir'));
    fs.writeFileSync(at('ror-dir/user.md'), 'mine\n');
    expect(() => {
      apply({ op: 'write_file', path: '${project}/ror-dir/user.md', content: 'x' });
    }).toThrow(managed.RefusedOperationError);
    expect(read('ror-dir/user.md')).toBe('mine\n');
  });

  it('refuses a managed_block on a symlink, the file it points at unchanged', () => {
    fs.writeFileSync(at('real.md'), 'mine\n');
    fs.symlinkSync('real.md', at('AGENTS.md'));
    expect(() => {
      apply(block('one'));
    }).toThrow(managed.RefusedOperationError);
    expect(read('real.md')).toBe('mine\n');
  });

  it('refuses a path a symlink carries outside its root', () => {
    fs.mkdirSync(join(base, 'outside'));
    fs.symlinkSync(join(base, 'outside'), at('link'));
    expect(() => {
      apply({ op: 'write_file', path: '${project}/link/ror-x.md', content: 'x' });
    }).toThrow(managed.RefusedOperationError);
    expect(fs.readdirSync(join(base, 'outside'))).toEqual([]);
  });

  // A locked ror- file the user replaced by a link to their own file: refusing, or acting on the
  // link itself, both leave README.md as it was.
  for (const operation of [
    { op: 'write_file', path: '${project}/ror-x.md', content: 'v2\n' },
    { op: 'remove_managed', path: '${project}/ror-x.md' },
  ] satisfies ContractOperation[]) {
    it(`does not ${operation.op} through a locked ror- file now a symlink to a user file`, () => {
      apply({ op: 'write_file', path: '${project}/ror-x.md', content: 'v1\n' });
      fs.writeFileSync(at('README.md'), 'mine\n');
      fs.rmSync(at('ror-x.md'));
      fs.symlinkSync('README.md', at('ror-x.md'));
      try {
        apply(operation);
      } catch (error) {
        expect(error).toBeInstanceOf(managed.RefusedOperationError);
      }
      expect(fs.existsSync(at('README.md')) && read('README.md')).toBe('mine\n');
    });
  }

  it('refuses remove_managed of a locked file now a folder, before any write', () => {
    apply({ op: 'write_file', path: '${project}/ror-a.md', content: 'a' });
    const before = lock();
    fs.rmSync(at('ror-a.md'));
    fs.mkdirSync(at('ror-a.md'));
    expect(() => {
      apply(
        { op: 'write_file', path: '${project}/ror-b.md', content: 'b' },
        { op: 'remove_managed', path: '${project}/ror-a.md' },
      );
    }).toThrow(managed.RefusedOperationError);
    expect(fs.existsSync(at('ror-b.md'))).toBe(false);
    expect(lock()).toEqual(before);
  });

  it('leaves no temporary file behind when a write cannot land', () => {
    expect(() => {
      apply(
        { op: 'write_file', path: '${project}/ror-a/b.md', content: 'b' },
        { op: 'write_file', path: '${project}/ror-a', content: 'a' },
      );
    }).toThrow();
    expect(fs.readdirSync(at('')).filter((name) => name.startsWith('.ror-'))).toEqual([]);
  });

  // SPEC-006 §2: a lock from an older ror may spell a path `./` or `//`; it stays removable.
  it('removes a locked path an older ror spelled with ./ or //, still confined to its root', () => {
    const older = ['${project}/./ror-o.md', '${project}/sub//ror-p.md', '${project}/./../ror-q.md'];
    fs.mkdirSync(at('sub'));
    for (const path of older) fs.writeFileSync(join(at(''), path.replace('${project}/', '')), 'x');
    fs.mkdirSync(at('.runonroad/lock'), { recursive: true });
    const entries = older.map((path) => ({ path, sha256: sha256('x') }));
    fs.writeFileSync(
      at('.runonroad/lock/claude_code.json'),
      JSON.stringify({ version: 1, entries }),
    );
    apply(...older.slice(0, 2).map((path) => ({ op: 'remove_managed' as const, path })));
    expect(fs.readdirSync(at('')).sort()).toEqual(['.runonroad', 'sub']);
    expect(fs.readdirSync(at('sub'))).toEqual([]);
    expect(() => {
      apply({ op: 'remove_managed', path: older[2] ?? '' });
    }).toThrow(managed.RefusedOperationError);
    expect(fs.existsSync(join(base, 'ror-q.md'))).toBe(true);
  });

  it('refuses an operation it does not execute, before any write', () => {
    expect(() => {
      apply(...vector('valid--write-file.json'), { op: 'ensure_dir', path: '${project}/.claude' });
    }).toThrow(managed.UnsupportedOperationError);
    expect(fs.readdirSync(at(''))).toEqual([]);
  });
});

describe('managed_block', () => {
  it('replaces only the text between its markers; the rest stays byte-identical', () => {
    fs.writeFileSync(at('AGENTS.md'), 'before\r\n  no newline at the end');
    apply(block('one'));
    const first = read('AGENTS.md');
    expect(first).toBe(
      'before\r\n  no newline at the end\n# runonroad:begin ror-governance\none\n# runonroad:end ror-governance',
    );
    fs.writeFileSync(at('AGENTS.md'), `${first}\nafter`);
    apply(block('two\n'));
    expect(read('AGENTS.md')).toBe(`${first.replace('one', 'two')}\nafter`);
    expect(lock()).toEqual([
      { path: '${project}/AGENTS.md', block_id: 'ror-governance', sha256: sha256('two\n') },
    ]);
  });

  it('adds then removes a block on a file with no final newline, its bytes back as they were', () => {
    for (const mine of ['mine', 'mine\n', 'a\r\nmine']) {
      fs.writeFileSync(at('AGENTS.md'), mine);
      apply(block('one'));
      apply(block('two'));
      apply({ op: 'remove_managed', path: '${project}/AGENTS.md', block_id: 'ror-governance' });
      expect(read('AGENTS.md'), JSON.stringify(mine)).toBe(mine);
    }
  });

  it('refuses block content holding a marker line, before any write', () => {
    fs.writeFileSync(at('AGENTS.md'), 'mine\n');
    for (const content of [
      'a\n# runonroad:end ror-governance\ntail\n',
      '<!-- runonroad:begin x -->',
    ]) {
      expect(() => {
        apply(block(content));
      }, content).toThrow(managed.RefusedOperationError);
    }
    expect(read('AGENTS.md')).toBe('mine\n');
    expect(fs.existsSync(at('.runonroad'))).toBe(false);
  });

  it('counts a marker only as a whole line, not one quoted in user text', () => {
    const mine = 'see # runonroad:begin ror-governance\n';
    fs.writeFileSync(at('AGENTS.md'), mine);
    apply(block('one'));
    expect(read('AGENTS.md')).toBe(
      `${mine}# runonroad:begin ror-governance\none\n# runonroad:end ror-governance\n`,
    );
  });

  it('refuses a root that does not exist, before any write', () => {
    expect(() => {
      managed.applyManaged([block('one')], {
        roots: { project: join(base, 'missing') },
        lockPath: at('.runonroad/lock/claude_code.json'),
      });
    }).toThrow(managed.RefusedOperationError);
    expect(fs.readdirSync(at(''))).toEqual([]);
  });

  // Git for Windows checks AGENTS.md out with CRLF (core.autocrlf), and Windows is supported (SPEC-007).
  it('replaces its block in a file checked out with CRLF line endings, not adds a second one', () => {
    apply(block('one'));
    fs.writeFileSync(at('AGENTS.md'), `mine\r\n${read('AGENTS.md').replaceAll('\n', '\r\n')}`);
    apply(block('two'));
    expect(read('AGENTS.md').match(/runonroad:begin/gu)).toHaveLength(1);
    expect(read('AGENTS.md')).toContain('two');
  });

  it('removes its block from a file checked out with CRLF line endings', () => {
    apply(block('one'));
    fs.writeFileSync(at('AGENTS.md'), `mine\r\n${read('AGENTS.md').replaceAll('\n', '\r\n')}`);
    apply({ op: 'remove_managed', path: '${project}/AGENTS.md', block_id: 'ror-governance' });
    expect(read('AGENTS.md')).toBe('mine\r\n');
    expect(lock()).toEqual([]);
  });

  it('refuses a block without its end marker, or an id that could break out of it', () => {
    const broken = 'a\n# runonroad:begin ror-governance\nkept\n';
    fs.writeFileSync(at('AGENTS.md'), broken);
    for (const operation of [block('x'), block('x', 'x -->\n<!-- y')]) {
      expect(() => {
        apply(operation);
      }).toThrow(managed.RefusedOperationError);
    }
    expect(read('AGENTS.md')).toBe(broken);
  });
});
