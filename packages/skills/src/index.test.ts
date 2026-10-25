import { describe, expect, it } from 'vitest';

import {
  checkTree,
  folderOf,
  headerValue,
  profileFindings,
  secretFindings,
  slugOf,
  treeDigest,
  validPath,
  type SkillFileInput,
} from './index.js';

const skill = (content: string, ...more: SkillFileInput[]): SkillFileInput[] => [
  { path: 'SKILL.md', content },
  ...more,
];
const codes = (findings: readonly { code: string }[]) => findings.map((finding) => finding.code);
// built at run time: the fixtures are shapes of secrets, not secrets
const awsShape = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const keyHeader = ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('');
const assignment = ['pass', 'word = "', 'x1'.repeat(10), '"'].join('');

describe('paths and names', () => {
  it('accepts relative canonical paths and nothing that leaves the tree', () => {
    for (const ok of ['SKILL.md', 'references/guide.md', 'a/b/c.txt', '.hidden']) {
      expect(validPath(ok)).toBe(true);
    }
    for (const bad of [
      '',
      '/x',
      '../x',
      'a/../b',
      'a//b',
      'a\\b',
      '.',
      '..',
      'a b',
      'é.md',
      'a/./b',
    ]) {
      expect(validPath(bad), bad).toBe(false);
    }
  });

  it('makes a slug from a name and a folder from a slug', () => {
    expect(slugOf('Rédiger un devis !')).toBe('rediger-un-devis');
    expect(slugOf('***')).toBe('');
    expect(folderOf('devis')).toBe('ror-lib-devis');
  });
});

describe('tree digest', () => {
  it('does not depend on order and changes with any byte', () => {
    const a = { path: 'a.md', content: 'one' };
    const b = { path: 'b.md', content: 'two' };
    expect(treeDigest([a, b])).toBe(treeDigest([b, a]));
    expect(treeDigest([a, b])).not.toBe(treeDigest([a, { ...b, content: 'tWo' }]));
    expect(treeDigest([a, b])).not.toBe(treeDigest([a, { ...b, path: 'c.md' }]));
    expect(treeDigest([a])).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

describe('checkTree', () => {
  it('requires SKILL.md and refuses collisions, control characters and size', () => {
    expect(codes(checkTree([{ path: 'a.md', content: 'x' }]))).toEqual(['skill_md_missing']);
    expect(codes(checkTree(skill('x', { path: 'skill.md', content: 'y' })))).toContain(
      'path_collision',
    );
    expect(codes(checkTree(skill('a\u0000b')))).toEqual(['content_not_text']);
    expect(codes(checkTree(skill('x'.repeat(262_145))))).toContain('file_too_large');
    expect(codes(checkTree(skill('ok')))).toEqual([]);
  });
});

describe('profile', () => {
  it('lets instructions, references and templates through', () => {
    expect(
      profileFindings(
        skill('---\nname: devis\ndescription: Write a quote\n---\n# Body\nUse `ls` freely.'),
      ),
    ).toEqual([]);
  });

  it('refuses hooks, delegation, allowed-tools and shell expansions', () => {
    const front = (key: string) => skill(`---\nname: x\n${key}: y\n---\nbody`);
    expect(codes(profileFindings(front('hooks')))).toEqual(['hooks_forbidden']);
    expect(codes(profileFindings(front('context')))).toEqual(['delegation_forbidden']);
    expect(codes(profileFindings(front('allowed-tools')))).toEqual(['allowed_tools_forbidden']);
    expect(codes(profileFindings(skill('Run !`git status` now')))).toEqual([
      'shell_expansion_forbidden',
    ]);
    expect(codes(profileFindings(skill('x', { path: 'a.md', content: '```!\nls\n```' })))).toEqual([
      'shell_expansion_forbidden',
    ]);
    expect(codes(profileFindings(skill('---\nname: x\nbody')))).toEqual(['frontmatter_invalid']);
  });
});

describe('headerValue', () => {
  it('reads a one-line value of the header, without its quotes, and nothing from the body', () => {
    const files = skill(
      '---\nname: devis\ndescription: "Write a quote"\n---\ndescription: not this',
    );
    expect(headerValue(files, 'description')).toBe('Write a quote');
    expect(headerValue(files, 'Name')).toBe('devis');
    expect(headerValue(files, 'missing')).toBe('');
    expect(headerValue(skill('no header'), 'description')).toBe('');
    expect(headerValue(skill('---\ndescription: x'), 'description')).toBe('');
    expect(
      headerValue(skill(`---\ndescription: ${'x'.repeat(500)}\n---\n`), 'description').length,
    ).toBe(300);
  });
});

describe('secrets', () => {
  it('flags the file, never the secret', () => {
    const found = secretFindings(skill(`key: ${awsShape}`, { path: 'ok.md', content: 'fine' }));
    expect(found).toEqual([{ code: 'secret_suspected', file: 'SKILL.md' }]);
    expect(JSON.stringify(found)).not.toContain(awsShape);
    expect(secretFindings(skill(keyHeader))).toHaveLength(1);
    expect(secretFindings(skill(assignment))).toHaveLength(1);
    expect(secretFindings(skill('Use a strong password and rotate it.'))).toEqual([]);
  });
});
