import type { RhsDocument } from '@runonroad/harness-spec';
import { describe, expect, it } from 'vitest';

import {
  GIT_EXCLUDE_PATTERNS,
  GOVERNANCE_FILE_PATH,
  HarnessTooLargeError,
  renderGovernanceFile,
  type Contribution,
  type Layer,
} from './render.js';

function document(
  slug: string,
  context: Partial<RhsDocument['context']> = {},
  version = '1.0.0',
): RhsDocument {
  return {
    rhs: 1,
    governance: { slug, name: slug, version, domain: 'it', category: 'conventions' },
    context: {
      preamble: '',
      allowed: '',
      preferred: '',
      ask_first: '',
      forbidden: '',
      ...context,
    },
  };
}

function contribution(
  slug: string,
  context: Partial<RhsDocument['context']>,
  options: { layer?: Layer; winner?: boolean; version?: string; assignment?: string } = {},
): Contribution {
  const { layer = 'org', winner = true, version = '1.0.0', assignment = `asg_${slug}` } = options;
  return {
    document: document(slug, context, version),
    version,
    assignments: [{ id: assignment, layer }],
    winner,
  };
}

const render = (contributions: readonly Contribution[], locale: 'fr' | 'en' = 'en'): string =>
  renderGovernanceFile(contributions, locale);

describe('the rendered instruction file', () => {
  it('opens with the managed header, which is what stops a human editing it', () => {
    const [title, managed] = render([contribution('hello', { forbidden: 'No secret.' })]).split(
      '\n',
    );
    expect(title).toBe('# RunOnRoad governance');
    expect(managed).toBe('<!-- Managed by RunOnRoad — do not edit -->');
  });

  it('states the precedence in English whatever the locale, without promising obedience', () => {
    for (const locale of ['fr', 'en'] as const) {
      const rendered = render([contribution('hello', { forbidden: 'x' })], locale);
      expect(rendered).toContain('Restrictions come first.');
      expect(rendered).toContain('follow the stricter one and ask');
    }
  });

  it('orders the sections strongest first: Forbidden, Ask first, Preferred, Allowed, Context', () => {
    const rendered = render([
      contribution('hello', {
        preamble: 'About.',
        allowed: 'a',
        preferred: 'p',
        ask_first: 'q',
        forbidden: 'f',
      }),
    ]);
    const positions = [
      '⛔ Forbidden',
      '✋ Ask first',
      '👍 Preferred',
      '✅ Allowed',
      '📋 Context',
    ].map((title) => rendered.indexOf(`## ${title}`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('omits an empty section rather than printing an empty heading', () => {
    const rendered = render([contribution('hello', { forbidden: 'f' })], 'fr');
    expect(rendered).toContain('⛔ Interdit');
    for (const absent of ['Autorisé', 'Préféré', 'Sous dérogation', 'Contexte']) {
      expect(rendered).not.toContain(absent);
    }
  });

  it('localizes the titles and nothing else', () => {
    const fr = render([contribution('hello', { forbidden: 'Commit a secret.' })], 'fr');
    const en = render([contribution('hello', { forbidden: 'Commit a secret.' })], 'en');
    expect(fr).toContain('## ⛔ Interdit');
    expect(en).toContain('## ⛔ Forbidden');
    expect(fr).toContain('Commit a secret.');
  });

  it("carries a block's text through as written, trimmed, with its source (ADR-0082)", () => {
    const rendered = render([
      contribution('ops', { ask_first: '\n- Touch production: ask the Lead.\n- Migrate.\n\n' }),
    ]);
    expect(rendered).toContain(
      '### ops@1.0.0 · org\n- Touch production: ask the Lead.\n- Migrate.\n<!-- /ops@1.0.0 -->',
    );
  });

  it('turns the line breaks of a browser textarea into \\n', () => {
    const rendered = render([contribution('hello', { forbidden: 'One.\r\nTwo.\rThree.' })]);
    expect(rendered).not.toContain('\r');
    expect(rendered).toContain('One.\nTwo.\nThree.');
  });

  it('uses \\n only, ends with one newline and never leaves a doubled blank line', () => {
    const rendered = render([
      contribution('hello', { preamble: 'A preamble.\n\n', forbidden: 'f\n\n\n' }),
    ]);
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.endsWith('\n\n')).toBe(false);
    expect(rendered).not.toContain('\n\n\n');
  });
});

describe('precedence between governances and layers (ADR-0084)', () => {
  it('keeps a broader layer’s Forbidden and Ask first when a narrower layer wins', () => {
    const rendered = render([
      contribution(
        'secure',
        { forbidden: 'ORG-FORBIDDEN', preferred: 'org-preferred' },
        {
          layer: 'org',
          winner: false,
          version: '1.0.0',
        },
      ),
      contribution(
        'secure',
        { forbidden: 'PROJECT-FORBIDDEN', preferred: 'project-preferred' },
        {
          layer: 'project',
          winner: true,
          version: '2.0.0',
          assignment: 'asg_project',
        },
      ),
    ]);
    expect(rendered).toContain('ORG-FORBIDDEN');
    expect(rendered).toContain('PROJECT-FORBIDDEN');
    // Preferred and Allowed come from the winning version only.
    expect(rendered).toContain('project-preferred');
    expect(rendered).not.toContain('org-preferred');
  });

  it('puts the broader layer first inside a section, then the governance slug', () => {
    const rendered = render([
      contribution('zeta', { forbidden: 'ZETA' }, { layer: 'org' }),
      contribution('alpha', { forbidden: 'ALPHA' }, { layer: 'project' }),
      contribution('beta', { forbidden: 'BETA' }, { layer: 'org' }),
    ]);
    const at = (text: string): number => rendered.indexOf(text);
    expect(at('BETA')).toBeLessThan(at('ZETA'));
    expect(at('ZETA')).toBeLessThan(at('ALPHA'));
  });

  it('is the same file whatever order the contributions arrive in', () => {
    const contributions = [
      contribution('a', { forbidden: 'A', allowed: 'a' }, { layer: 'team' }),
      contribution('b', { ask_first: 'B', preamble: 'about b' }, { layer: 'org' }),
      contribution('c', { forbidden: 'C' }, { layer: 'project', winner: false, version: '0.9.0' }),
    ];
    expect(render([...contributions].reverse())).toBe(render(contributions));
  });

  it('places a version reached by several assignments once, at its first assignment', () => {
    const both: Contribution = {
      ...contribution('shared', { forbidden: 'SHARED' }),
      assignments: [
        { id: 'asg_a', layer: 'org' },
        { id: 'asg_b', layer: 'project' },
      ],
    };
    const rendered = render([
      both,
      contribution('later', { forbidden: 'LATER' }, { layer: 'team' }),
    ]);
    expect(rendered.split('SHARED')).toHaveLength(2);
    expect(rendered.indexOf('SHARED')).toBeLessThan(rendered.indexOf('LATER'));
    expect(rendered).toContain('### shared@1.0.0 · org');
  });

  it('only a winner brings its preamble', () => {
    const rendered = render([
      contribution('x', { preamble: 'LOSER-PREAMBLE', forbidden: 'f' }, { winner: false }),
      contribution('y', { preamble: 'WINNER-PREAMBLE' }),
    ]);
    expect(rendered).toContain('WINNER-PREAMBLE');
    expect(rendered).not.toContain('LOSER-PREAMBLE');
  });

  it('refuses to truncate: a file over the cap fails the compile', () => {
    const big = 'x'.repeat(10_000);
    const many = Array.from({ length: 40 }, (_, index) =>
      contribution(`gov-${String(index).padStart(2, '0')}`, { forbidden: big, ask_first: big }),
    );
    expect(() => render(many)).toThrow(HarnessTooLargeError);
  });
});

describe('where it writes', () => {
  it('writes one file under the project root', () => {
    expect(GOVERNANCE_FILE_PATH).toBe('${project}/.claude/rules/ror-governance.md');
  });

  it('excludes its own output from git', () => {
    expect([...GIT_EXCLUDE_PATTERNS]).toEqual(['.claude/rules/ror-*', '.runonroad/lock/']);
  });
});
