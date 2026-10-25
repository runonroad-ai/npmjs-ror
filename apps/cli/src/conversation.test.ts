/**
 * The conversation checked end to end on the client (ADR-0088): `ror sync` activates a content
 * rule and registers the hooks; `ror hook` stops an explicit violation in the prompt, in the file
 * about to be written and in the answer, and only points the AI at what it cannot decide.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Capabilities } from './coverage.js';
import { shellCandidates } from './candidates.js';
import { check, type ContentRule } from '@runonroad/content-rules';

import { blockReason, injectionContext } from './conversation.js';
import { runHook } from './hook.js';
import { status } from './status.js';
import type { Enrolment } from './session.js';
import { saveEnrolment } from './testing/enrol.js';
import { fakeServer, KEY, type Fake } from './testing/fake-server.js';
import { sync } from './sync.js';

const CAPABLE: Capabilities = { sandbox: true, claudeVersion: '2.1.301' };
const NOW = new Date('2026-10-17T12:00:00.000Z');

const discount = (decision: 'forbid' | 'ask' = 'forbid') => ({
  id: 'g@1.0.0:discount',
  source: 'g@1.0.0',
  kind: 'content',
  decision,
  reason: 'A tender discount never exceeds 5 %.',
  required: true,
  topic: 'tenders',
  text: 'No discount above 5 % in a tender.',
  subject_aliases: ['remise', 'discount'],
  scopes: ['prompt', 'file_write', 'answer'],
  mode: 'block',
  constraint: {
    kind: 'number_bound',
    operator: 'lte',
    limit: '5',
    unit: 'percent',
    binding_window: 6,
  },
  alternatives: ['Offer a longer payment term', 'Offer a volume tier'],
});
const policy = (
  derogations: { rule_id: string; expires_at: string }[] = [],
  decision: 'forbid' | 'ask' = 'forbid',
) => ({
  schema_version: 1,
  principal: 'mem_lea',
  mcp_allow: [],
  rules: [discount(decision)],
  derogations,
});
const operations = [
  {
    op: 'write_file',
    path: '${project}/.claude/rules/ror-governance.md',
    content:
      '# RunOnRoad governance\n<!-- Managed by RunOnRoad — do not edit -->\nNo discount above 5 %.\n',
  },
  { op: 'git_exclude', pattern: '.runonroad/lock/' },
];

let fake: Fake;
let project: string;
let home: string;
let enrolment: Enrolment;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ror-conv-home-'));
  project = mkdtempSync(join(tmpdir(), 'ror-conv-project-'));
  process.env['RUNONROAD_HOME'] = join(home, '.runonroad');
  process.env['HOME'] = home;
  process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude');
  process.env['CLAUDE_PROJECT_DIR'] = project;
  execFileSync('git', ['init', '-q'], { cwd: project });
  fake = await fakeServer();
  fake.next = { operations, policy: policy() };
  enrolment = {
    api: fake.url,
    device_token: `rord_${'a'.repeat(43)}`,
    organization_id: 'org_test',
    keys: [KEY],
  };
  saveEnrolment(enrolment);
  const outcome = await sync(
    { fetch, now: () => NOW, projectDir: project, capabilities: CAPABLE },
    enrolment,
  );
  expect(outcome.status).toBe('applied');
});

afterEach(() => {
  fake.server.close();
  delete process.env['CLAUDE_PROJECT_DIR'];
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const payload = (event: string, extra: Record<string, unknown>): string =>
  JSON.stringify({ hook_event_name: event, cwd: project, ...extra });
const hook = (event: string, extra: Record<string, unknown>, at = NOW) =>
  runHook(payload(event, extra), at, 'claude_code');
const parsed = (stdout: string): Record<string, unknown> =>
  stdout === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>);
const context = (stdout: string): string =>
  (parsed(stdout)['hookSpecificOutput'] as { additionalContext?: string } | undefined)
    ?.additionalContext ?? '';

describe('activation', () => {
  it('registers the prompt and the stop hooks next to the tool hook, and says what is checked', () => {
    const settings = JSON.parse(
      readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'),
    ) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit']);
    const report = status(project, CAPABLE);
    expect(report.rules.find((rule) => rule.id === 'g@1.0.0:discount')).toMatchObject({
      status: 'partial',
      required: true,
    });
  });

  it('refuses a policy whose rules would not fit in the AI’s context', async () => {
    const big = { ...discount(), text: 'x'.repeat(2000) };
    fake.next = {
      operations,
      issuedAt: '2026-10-17T11:00:00.000Z',
      policy: {
        ...policy(),
        rules: Array.from({ length: 20 }, (_, i) => ({ ...big, id: `g@1.0.0:r${String(i)}` })),
      },
    };
    const outcome = await sync(
      { fetch, now: () => NOW, projectDir: project, capabilities: CAPABLE },
      enrolment,
    );
    expect(outcome.status).toBe('refused');
    expect(outcome.message).toContain('context');
  });
});

describe('the prompt', () => {
  it('stops an explicit violation before the AI sees it, with the rule and the alternatives', () => {
    const result = hook('UserPromptSubmit', {
      prompt: 'Je veux mettre 10% de remise sur cet appel d’offres',
    });
    const out = parsed(result.stdout);
    expect(out['decision']).toBe('block');
    expect(out['reason']).toContain('g@1.0.0:discount');
    expect(out['reason']).toContain('Offer a longer payment term');
  });

  it('does not stop a 10 % that is not the discount, and gives the AI the rules', () => {
    const result = hook('UserPromptSubmit', {
      prompt: 'Nous avons besoin de gains de productivité d’au moins 10%',
    });
    expect(parsed(result.stdout)['decision']).toBeUndefined();
    expect(context(result.stdout)).toContain('g@1.0.0:discount');
    expect(context(result.stdout)).toContain('Bind every value to its subject');
  });

  it('points the AI at a doubtful spot instead of blocking', () => {
    const result = hook('UserPromptSubmit', { prompt: 'Une remise de dix pour cent ?' });
    expect(parsed(result.stdout)['decision']).toBeUndefined();
    expect(context(result.stdout)).toContain('could not decide by itself');
  });

  it('lets a compliant request through with the rules', () => {
    const result = hook('UserPromptSubmit', { prompt: 'Applique une remise de 4 %' });
    expect(parsed(result.stdout)['decision']).toBeUndefined();
    expect(context(result.stdout)).toContain('Rules:');
  });
});

describe('the rules put in front of the AI', () => {
  it('say where each rule applies, so a file-only rule does not govern the chat', () => {
    const text = injectionContext([
      { ...discount(), scopes: ['file_write'] } as never,
      { ...discount(), id: 'g@1.0.0:b', scopes: ['prompt', 'answer'] } as never,
    ]);
    expect(text).toContain('applies to: what you write in files)');
    expect(text).toContain('applies to: the person’s requests, your answers)');
    expect(text).toContain('Apply each rule only where it says it applies');
  });
});

describe('alternatives given to the AI', () => {
  it('an alternative that would itself break a rule is not offered in a refusal', () => {
    const bad = {
      ...discount(),
      alternatives: ['Offer a 12% discount instead', 'Offer a longer payment term'],
    } as never as ContentRule;
    const finding = check(bad, 'Remise de 10 %')[0];
    if (finding === undefined) throw new Error('a finding');
    const reason = blockReason([finding], [bad]);
    expect(reason).toContain('longer payment term');
    expect(reason).not.toContain('12% discount');
  });

  it('leave out an alternative that would itself break a rule', () => {
    const bad = {
      ...discount(),
      alternatives: ['Offer a 12% discount instead', 'Offer a longer payment term'],
    };
    const text = injectionContext([bad as never]);
    expect(text).toContain('longer payment term');
    expect(text).not.toContain('12% discount');
  });
});

describe('what the AI is about to write', () => {
  const tool = (name: string, input: Record<string, unknown>) =>
    parsed(hook('PreToolUse', { tool_name: name, tool_input: input }).stdout);
  const denied = (out: Record<string, unknown>): boolean =>
    (out['hookSpecificOutput'] as { permissionDecision?: string } | undefined)
      ?.permissionDecision === 'deny';

  it('denies a Write whose content breaks the rule, and lets a good one through', () => {
    expect(
      denied(tool('Write', { file_path: join(project, 'quote.md'), content: 'Remise: 10 %' })),
    ).toBe(true);
    expect(
      denied(
        tool('Write', {
          file_path: join(project, 'quote.md'),
          content: 'Remise: 4 %\nProductivité: 10 %',
        }),
      ),
    ).toBe(false);
    expect(
      denied(tool('Write', { file_path: join(project, 'a.json'), content: '{"discount": "12%"}' })),
    ).toBe(true);
  });

  it('rebuilds an Edit against the file as it is, not just the new text', () => {
    const file = join(project, 'quote.md');
    writeFileSync(file, 'Titre\nRemise : 3 %\nFin\n');
    expect(denied(tool('Edit', { file_path: file, old_string: '3 %', new_string: '9 %' }))).toBe(
      true,
    );
    expect(denied(tool('Edit', { file_path: file, old_string: '3 %', new_string: '4 %' }))).toBe(
      false,
    );
    // an edit that does not apply is refused rather than waved through
    expect(denied(tool('Edit', { file_path: file, old_string: 'absent', new_string: 'x' }))).toBe(
      true,
    );
  });

  it('rebuilds a MultiEdit in order', () => {
    const file = join(project, 'q.md');
    writeFileSync(file, 'Remise : 3 %\n');
    const edits = [
      { old_string: '3 %', new_string: '8 %' },
      { old_string: '8 %', new_string: '4 %' },
    ];
    expect(denied(tool('MultiEdit', { file_path: file, edits }))).toBe(false);
  });

  it('reads an apply_patch: added files and updated files', () => {
    const add = `*** Begin Patch\n*** Add File: q.md\n+Remise : 11 %\n*** End Patch`;
    expect(
      denied(
        parsed(
          runHook(
            JSON.stringify({
              hook_event_name: 'PreToolUse',
              cwd: project,
              tool_name: 'apply_patch',
              tool_input: { command: add },
            }),
            NOW,
            'claude_code',
          ).stdout,
        ),
      ),
    ).toBe(true);
    writeFileSync(join(project, 'r.md'), 'Remise : 3 %\nFin\n');
    const update = `*** Begin Patch\n*** Update File: r.md\n@@\n-Remise : 3 %\n+Remise : 9 %\n*** End Patch`;
    expect(
      denied(
        parsed(
          runHook(
            JSON.stringify({
              hook_event_name: 'PreToolUse',
              cwd: project,
              tool_name: 'apply_patch',
              tool_input: { command: update },
            }),
            NOW,
            'claude_code',
          ).stdout,
        ),
      ),
    ).toBe(true);
  });

  it('reads a rename that also changes the file', () => {
    writeFileSync(join(project, 's.md'), 'Remise : 3 %\nFin\n');
    const patch = `*** Begin Patch\n*** Update File: s.md\n*** Move to: t.md\n@@\n-Remise : 3 %\n+Remise : 9 %\n*** End Patch`;
    const out = parsed(
      runHook(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: project,
          tool_name: 'apply_patch',
          tool_input: { command: patch },
        }),
        NOW,
        'claude_code',
      ).stdout,
    );
    expect(denied(out)).toBe(true);
  });

  it('hands the AI a doubtful write as a signal and does not block it', () => {
    const out = tool('Write', {
      file_path: join(project, 'n.md'),
      content: 'Remise de dix pour cent',
    });
    expect(denied(out)).toBe(false);
    expect(JSON.stringify(out)).toContain('could not decide by itself');
  });
});

describe('a plain shell write', () => {
  const bash = (command: string) =>
    parsed(
      runHook(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: project,
          tool_name: 'Bash',
          tool_input: { command },
        }),
        NOW,
        'claude_code',
      ).stdout,
    );
  const denied = (out: Record<string, unknown>): boolean =>
    (out['hookSpecificOutput'] as { permissionDecision?: string } | undefined)
      ?.permissionDecision === 'deny';

  it('is judged on what it copies: cp, cat to a file, tee', () => {
    writeFileSync(join(project, 'src.md'), 'Offre\nRemise : 12 %\n');
    writeFileSync(join(project, 'ok.md'), 'Offre\nRemise : 3 %\n');
    expect(denied(bash('cp src.md out.md'))).toBe(true);
    expect(denied(bash('cat src.md > out.md'))).toBe(true);
    expect(denied(bash('cat src.md | tee out.md'))).toBe(true);
    expect(denied(bash('tee out.md < src.md'))).toBe(true);
    expect(denied(bash('mv src.md out.md'))).toBe(true);
    expect(denied(bash('cp ok.md out.md'))).toBe(false);
  });

  it('is judged on the text it writes: echo and here-documents', () => {
    expect(denied(bash('echo "Remise : 12 %" > devis.md'))).toBe(true);
    expect(denied(bash("cat <<'EOF' > devis.md\nLa remise sera de 12 %\nEOF"))).toBe(true);
    expect(denied(bash('echo "Remise : 3 %" > devis.md'))).toBe(false);
  });

  it('judges the result of a sed -i substitution, and refuses a file too large to read', () => {
    writeFileSync(join(project, 'offer.md'), 'Remise : 3 %\n');
    expect(denied(bash("sed -i 's/3/12/' offer.md"))).toBe(true);
    expect(denied(bash("sed -i 's/3/4/' offer.md"))).toBe(false);
    // sed substitutes in EVERY line: the 3 of the reference line and the 3 of the discount
    writeFileSync(join(project, 'two.md'), 'Reference: 3\nRemise : 3 %\n');
    expect(denied(bash("sed -i 's/3/12/' two.md"))).toBe(true);
    // forms it cannot rebuild with sed's own semantics are refused
    expect(denied(bash("sed -i -e 's/3/4/' -e 's/4/12/' two.md"))).toBe(true);
    expect(denied(bash("sed -i 's/3/&2/' two.md"))).toBe(true);
    expect(denied(bash("sed -i -E 's/(3)/\\1/' two.md"))).toBe(true);
    // a script it cannot interpret is not waved through
    expect(denied(bash("sed -i -e '1d;$a\\x' offer.md"))).toBe(true);
    writeFileSync(join(project, 'big.md'), `${'x'.repeat(1024 * 1024 + 10)}\n`);
    expect(denied(bash('cp big.md out.md'))).toBe(true);
  });

  it('does not touch a command that writes nothing', () => {
    writeFileSync(join(project, 'src.md'), 'Remise : 12 %\n');
    expect(denied(bash('cat src.md'))).toBe(false);
    expect(denied(bash('grep -n "Remise : 12 %" src.md'))).toBe(false);
    expect(denied(bash('git commit -m "Remise 12 %"'))).toBe(false);
  });
});

describe('the answer', () => {
  it('sends the AI back to correct itself, once', () => {
    const first = hook('Stop', { last_assistant_message: 'Voici : remise de 10 % accordée.' });
    expect(parsed(first.stdout)['decision']).toBe('block');
    expect(String(parsed(first.stdout)['reason'])).toContain('Correct it now');
    const again = hook('Stop', {
      last_assistant_message: 'Voici : remise de 10 % accordée.',
      stop_hook_active: true,
    });
    expect(again.stdout).toBe('');
  });

  it('leaves a good answer alone', () => {
    expect(hook('Stop', { last_assistant_message: 'La remise est limitée à 5 %.' }).stdout).toBe(
      '',
    );
    expect(hook('Stop', { last_assistant_message: 'Gains de productivité de 10 %.' }).stdout).toBe(
      '',
    );
  });
});

describe('Ask-first and derogations', () => {
  it('an Ask-first content rule blocks with how to ask, and a lease lifts it for its length only', async () => {
    fake.next = { operations, issuedAt: '2026-10-17T11:30:00.000Z', policy: policy([], 'ask') };
    await sync({ fetch, now: () => NOW, projectDir: project, capabilities: CAPABLE }, enrolment);
    const blocked = hook('UserPromptSubmit', { prompt: 'remise de 10 %' });
    expect(String(parsed(blocked.stdout)['reason'])).toContain('ror derogation request');
    fake.next = {
      operations,
      issuedAt: '2026-10-17T11:45:00.000Z',
      policy: policy(
        [{ rule_id: 'g@1.0.0:discount', expires_at: '2026-10-17T13:00:00.000Z' }],
        'ask',
      ),
    };
    await sync({ fetch, now: () => NOW, projectDir: project, capabilities: CAPABLE }, enrolment);
    expect(
      parsed(hook('UserPromptSubmit', { prompt: 'remise de 10 %' }).stdout)['decision'],
    ).toBeUndefined();
    const later = new Date('2026-10-17T13:30:00.000Z');
    expect(
      parsed(hook('UserPromptSubmit', { prompt: 'remise de 10 %' }, later).stdout)['decision'],
    ).toBe('block');
  });

  it('an Ask-first command rule denies the tool call and names the command to ask with', async () => {
    const askRm = {
      id: 'g@1.0.0:ask-rm',
      source: 'g@1.0.0',
      kind: 'command',
      decision: 'ask',
      reason: 'Deleting a tree needs a second look.',
      required: false,
      executable: 'rm',
      argv_prefix: [],
      flags_any: ['-rf'],
    };
    fake.next = {
      operations,
      issuedAt: '2026-10-17T11:40:00.000Z',
      policy: { ...policy(), rules: [askRm] },
    };
    await sync({ fetch, now: () => NOW, projectDir: project, capabilities: CAPABLE }, enrolment);
    const out = parsed(
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }).stdout,
    )['hookSpecificOutput'] as { permissionDecision?: string; permissionDecisionReason?: string };
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('ror derogation request g@1.0.0:ask-rm');
  });

  it('a Forbidden content rule is never lifted by a lease', async () => {
    fake.next = {
      operations,
      issuedAt: '2026-10-17T11:45:00.000Z',
      policy: policy(
        [{ rule_id: 'g@1.0.0:discount', expires_at: '2026-10-17T13:00:00.000Z' }],
        'forbid',
      ),
    };
    await sync({ fetch, now: () => NOW, projectDir: project, capabilities: CAPABLE }, enrolment);
    expect(parsed(hook('UserPromptSubmit', { prompt: 'remise de 10 %' }).stdout)['decision']).toBe(
      'block',
    );
  });
});

describe('a project with no content rule', () => {
  it('says nothing and blocks nothing', async () => {
    fake.next = {
      operations,
      issuedAt: '2026-10-17T11:50:00.000Z',
      policy: { ...policy(), rules: [] },
    };
    await sync({ fetch, now: () => NOW, projectDir: project, capabilities: CAPABLE }, enrolment);
    mkdirSync(join(project, 'x'), { recursive: true });
    expect(hook('UserPromptSubmit', { prompt: 'remise de 90 %' }).stdout).toBe('');
    expect(hook('Stop', { last_assistant_message: 'remise de 90 %' }).stdout).toBe('');
  });
});

// The reconstruction mimics GNU sed. BSD sed (macOS) wants `-i ''` and has no `I` flag, and Windows has no sed:
// there the comparison with "the real sed" has nothing to compare with, so it is skipped, on purpose.
const gnuSed = ((): boolean => {
  // Git for Windows ships a GNU sed that cannot rename across the runner's drives: not a comparison either
  if (process.platform === 'win32') return false;
  // the Linux job is the designated place of this comparison: a missing GNU sed there must fail, not skip
  if (process.platform === 'linux') return true;
  try {
    execFileSync('sed', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('the sed -i reconstruction matches the real sed', () => {
  it.skipIf(!gnuSed)('gives the same file as sed on the forms it accepts', () => {
    const cases: [string, string][] = [
      ['Reference: 3\nRemise : 3 %\nx 3 3\n', 's/3/12/'],
      ['aaa\nbab\n', 's/a/X/g'],
      ['Foo foo\n', 's/foo/Z/I'],
      ['a+b (c)\n', 's/+/-/'],
      ['a.b\n', 's/a.b/Q/'],
      ['x1x\n', 's|x|y|g'],
    ];
    for (const [text, script] of cases) {
      const file = join(project, 'f.txt');
      writeFileSync(file, text);
      const found = shellCandidates({
        tool_name: 'Bash',
        tool_input: { command: `sed -i '${script}' f.txt` },
        cwd: project,
      });
      execFileSync('sed', ['-i', script, file]);
      expect(found.unreadable, script).toBe(false);
      expect(found.texts, script).toContain(readFileSync(file, 'utf8'));
    }
  });
});

describe('shell redirections: the result is judged, not the fragment or the old file', () => {
  it('judges old text plus appended text, and ignores the old text of an overwritten file', () => {
    const file = join(project, 'out.txt');
    writeFileSync(file, 'discount: ');
    const run = (command: string) =>
      shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project });
    expect(run('echo 10% >> out.txt').texts.some((t) => t.includes('discount: 10%'))).toBe(true);
    expect(run('echo hello > out.txt').texts.some((t) => t.includes('discount'))).toBe(false);
  });
});

describe('attestation of what code cannot decide (ADR-0090)', () => {
  const call = (name: string, input: Record<string, unknown>, session = 's1', turn = 't1') =>
    parsed(
      runHook(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: project,
          session_id: session,
          prompt_id: turn,
          tool_name: name,
          tool_input: input,
        }),
        NOW,
        'claude_code',
      ).stdout,
    );
  const reasonOf = (out: Record<string, unknown>): string =>
    (out['hookSpecificOutput'] as { permissionDecisionReason?: string } | undefined)
      ?.permissionDecisionReason ?? '';
  const denied = (out: Record<string, unknown>): boolean => reasonOf(out) !== '';
  const doubtful = { file_path: '', content: 'La remise sera de dix pour cent.' };
  const write = (session = 's1') =>
    call('Write', { ...doubtful, file_path: join(project, 'q.md') }, session);
  const idOf = (reason: string): string => /--challenge ([a-f0-9]{24})/u.exec(reason)?.[1] ?? '';
  const attest = (id: string, entries: unknown, session = 's1') =>
    call(
      'Bash',
      { command: `ror attest --challenge ${id} --facts '${JSON.stringify({ entries })}'` },
      session,
    );

  it('asks first, accepts a covering answer with a real quote, then lets the same change through', () => {
    const first = reasonOf(write());
    expect(first).toContain('attest --challenge');
    const id = idOf(first);
    expect(id).not.toBe('');
    const recorded = reasonOf(
      attest(id, [
        { occurrence: 'o1', verdict: 'not_applicable', evidence: 'remise sera de dix pour cent' },
      ]),
    );
    expect(recorded).toContain('Attestation recorded');
    expect(denied(write())).toBe(false);
  });

  it('refuses an answer whose quote is not in the content, or is about another spot, or reports a violation', () => {
    const id = idOf(reasonOf(write()));
    const bad = (evidence: string, verdict = 'not_applicable'): string =>
      reasonOf(attest(id, [{ occurrence: 'o1', verdict, evidence }]));
    expect(bad('words that are nowhere')).toContain('not words found in the content');
    expect(bad('La', 'not_applicable')).toContain('not about the spot');
    expect(bad('remise sera de dix pour cent', 'violation')).toContain('reported a violation');
    expect(reasonOf(attest(id, []))).toContain('has no entry');
    expect(reasonOf(attest(id, 'nope'))).toContain('must be a list');
    // after a rejection the same change is asked again, not allowed
    expect(reasonOf(write())).toContain('Your last answer was not accepted');
  });

  it('refuses answers that are not even well formed, a null entry included, without failing', () => {
    const id = idOf(reasonOf(write()));
    expect(reasonOf(attest(id, []))).toContain('has no entry');
    expect(reasonOf(attest(id, 'nope'))).toContain('must be a list');
    expect(reasonOf(attest(id, [null]))).toContain('every entry must be an object');
  });

  it('binds the answer to the conversation and to this very change', () => {
    const id = idOf(reasonOf(write()));
    const entries = [
      { occurrence: 'o1', verdict: 'not_applicable', evidence: 'remise sera de dix pour cent' },
    ];
    // another conversation cannot use it
    expect(reasonOf(attest(id, entries, 'other'))).toContain('no pending question');
    expect(reasonOf(attest(id, entries))).toContain('Attestation recorded');
    expect(denied(write('other'))).toBe(true);
    // a changed content needs its own question
    const changed = call('Write', {
      file_path: join(project, 'q.md'),
      content: 'La remise sera de douze pour cent.',
    });
    expect(reasonOf(changed)).toContain('attest --challenge');
  });

  it('never lifts a violation code found by itself', () => {
    const out = call('Write', { file_path: join(project, 'v.md'), content: 'Remise : 12 %' });
    expect(reasonOf(out)).toContain('Blocked by RunOnRoad rule');
    expect(reasonOf(out)).not.toContain('attest --challenge');
  });

  it('bounds the answers too, and an accepted answer is not renewed', () => {
    const id = idOf(reasonOf(write()));
    let last = '';
    for (let i = 0; i < 8; i += 1) last = reasonOf(attest(id, []));
    expect(last).toContain('used all its tries');
    // a good answer after the budget is spent does not get through
    expect(
      reasonOf(
        attest(id, [
          { occurrence: 'o1', verdict: 'not_applicable', evidence: 'remise sera de dix pour cent' },
        ]),
      ),
    ).toContain('used all its tries');
    expect(denied(write())).toBe(true);
  });

  it('finds a quote next to a spot far into a large content', () => {
    const big = `${'x '.repeat(600_000)}La remise sera de dix pour cent.`;
    const first = reasonOf(call('Write', { file_path: join(project, 'big.md'), content: big }));
    const id = idOf(first);
    expect(id).not.toBe('');
    expect(
      reasonOf(
        attest(id, [
          { occurrence: 'o1', verdict: 'not_applicable', evidence: 'remise sera de dix pour cent' },
        ]),
      ),
    ).toContain('Attestation recorded');
  });

  it('gives up after a few tries', () => {
    let reason = '';
    for (let i = 0; i < 5; i += 1) reason = reasonOf(write());
    expect(reason).toContain('could not settle these spots');
  });

  it('only a command that is exactly the attestation is taken as one', () => {
    const id = idOf(reasonOf(write()));
    const chained = call('Bash', {
      command: `ror attest --challenge ${id} --facts '{}' ; echo hi`,
    });
    expect(reasonOf(chained)).toBe('');
    const redirected = call('Bash', { command: `ror attest --challenge ${id} --facts '{}' > x` });
    expect(reasonOf(redirected)).toBe('');
  });

  it('without a conversation to bind to, a doubt stays a signal', () => {
    const out = parsed(
      runHook(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: project,
          tool_name: 'Write',
          tool_input: {
            file_path: join(project, 'z.md'),
            content: 'La remise sera de dix pour cent.',
          },
        }),
        NOW,
        'claude_code',
      ).stdout,
    );
    expect(JSON.stringify(out)).toContain('could not decide by itself');
  });
});

describe('cat into an appended file', () => {
  it('judges the old text followed by the bytes copied', () => {
    writeFileSync(join(project, 'o2.txt'), 'discount: ');
    writeFileSync(join(project, 'v2.txt'), '10%');
    const found = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: 'cat v2.txt >> o2.txt' },
      cwd: project,
    });
    expect(found.texts).toContain('discount: 10%');
  });
  it('judges several files concatenated', () => {
    writeFileSync(join(project, 'o3.txt'), 'discount: ');
    writeFileSync(join(project, 'a3.txt'), '1');
    writeFileSync(join(project, 'b3.txt'), '0%');
    const found = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: 'cat a3.txt b3.txt >> o3.txt' },
      cwd: project,
    });
    expect(found.texts).toContain('discount: 10%');
  });
});

describe('whole-line shell reconstruction', () => {
  it('judges cat a b > out and earlier writes of the same line', () => {
    writeFileSync(join(project, 'a4.txt'), 'discount: 1');
    writeFileSync(join(project, 'b4.txt'), '0%');
    const run = (command: string) =>
      shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
    expect(run('cat a4.txt b4.txt > o4.txt')).toContain('discount: 10%');
    expect(run("printf 'discount: 1' > o5.txt; printf '0%' >> o5.txt")).toContain('discount: 10%');
  });
});

describe('echo keeps its line ending', () => {
  it('does not glue two echo lines into one value', () => {
    const texts = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: "echo 'discount: 1' > f9.txt; echo '0%' >> f9.txt" },
      cwd: project,
    }).texts;
    expect(texts).not.toContain('discount: 10%');
    expect(texts).toContain('discount: 1\n0%\n');
  });
});

describe('printf and equivalent paths', () => {
  it('rebuilds printf output and tracks ./f and f as one file', () => {
    const run = (command: string) =>
      shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
    expect(run("printf '%s' 'discount: 1' > f8.txt; printf '%s' '0%' >> f8.txt")).toContain(
      'discount: 10%',
    );
    expect(run("printf 'discount: 1' > f7.txt; printf '0%%' >> ./f7.txt")).toContain(
      'discount: 10%',
    );
  });
});

describe('printf %d', () => {
  it('reads 010 as octal 8', () => {
    const texts = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: "printf 'discount: %d%%' 010 > o9.txt" },
      cwd: project,
    }).texts;
    expect(texts).toContain('discount: 8%');
  });
});

describe('cp then append, and a literal %% in printf', () => {
  it('follows a copy and terminates', () => {
    const texts = shellCandidates({
      tool_name: 'Bash',
      tool_input: {
        command: "printf 'discount: ' > a6.txt; cp a6.txt b6.txt; printf '10%%' >> b6.txt",
      },
      cwd: project,
    }).texts;
    expect(texts).toContain('discount: 10%');
    expect(
      shellCandidates({
        tool_name: 'Bash',
        tool_input: { command: "printf '%%s' foo > o7.txt" },
        cwd: project,
      }).texts,
    ).toContain('%s');
  });
});

describe('review round 11', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project });
  it('refuses a printf format it cannot evaluate, follows cat <, and ignores a replaced destination', () => {
    expect(run("printf 'discount: %.0f%%' 12 > o10.txt").unreadable).toBe(true);
    expect(
      run("printf 'discount: ' > a11.txt; cat < a11.txt > b11.txt; printf '12%%' >> b11.txt").texts,
    ).toContain('discount: 12%');
    writeFileSync(join(project, 'safe.txt'), 'ok');
    writeFileSync(join(project, 'dest.txt'), 'forbidden-old');
    expect(run('cp safe.txt dest.txt').texts.join('|')).not.toContain('forbidden-old');
  });
});

describe('review round 12', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project });
  it('drops echo options and refuses printf escapes it cannot decode', () => {
    expect(run("echo -n 'discount: 1' > e1.txt; echo -n '2%' >> e1.txt").texts).toContain(
      'discount: 12%',
    );
    expect(run("printf '\\144iscount: 12%%' > e2.txt").unreadable).toBe(true);
  });
});

describe('echo -e', () => {
  it('refuses escapes it cannot decode', () => {
    const found = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: "echo -e '\\x64iscount: 12%' > e3.txt" },
      cwd: project,
    });
    expect(found.unreadable).toBe(true);
  });
});

describe('pipes into tee and a bare cat', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('hands the printed text to the writer', () => {
    expect(run("printf 'discount: 1' > t1.txt; printf '2%%' | tee -a t1.txt")).toContain(
      'discount: 12%',
    );
    expect(run("printf 'discount: 1' > t2.txt; printf '2%%' | cat >> t2.txt")).toContain(
      'discount: 12%',
    );
  });
});

describe('forwarding commands in a pipeline', () => {
  it('keeps the text through cat and tee', () => {
    const texts = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: "printf 'discount: ' | cat | tee t3.txt; printf '12%%' >> t3.txt" },
      cwd: project,
    }).texts;
    expect(texts).toContain('discount: 12%');
  });
});

describe('cat reading a file into a pipe', () => {
  it('carries the file text to tee', () => {
    const texts = shellCandidates({
      tool_name: 'Bash',
      tool_input: {
        command: "printf 'discount: ' > s4.txt; cat s4.txt | tee d4.txt; printf '10%%' >> d4.txt",
      },
      cwd: project,
    }).texts;
    expect(texts).toContain('discount: 10%');
  });
});

describe('operands that echo, printf and tee only print', () => {
  it('does not read a named file as content', () => {
    writeFileSync(join(project, 'named.txt'), 'forbidden-old');
    const run = (command: string) =>
      shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts.join('|');
    expect(run('echo named.txt > o12.txt')).not.toContain('forbidden-old');
    expect(run('printf safe | tee named.txt')).not.toContain('forbidden-old');
  });
});

describe('tee with a redirection and /dev/null', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('follows tee > out and an empty cat', () => {
    expect(run("printf 'discount: 1' | tee > t5.txt; printf '0%%' >> t5.txt")).toContain(
      'discount: 10%',
    );
    expect(
      run("printf 'discount: 1' > t6.txt; cat /dev/null | tee t6.txt; printf '0%%' >> t6.txt"),
    ).not.toContain('discount: 10%');
  });
});

describe('round 17', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('follows install, prints 0 for a missing %d and drops redirected stdout from the pipe', () => {
    expect(
      run("printf %s 'discount: 1' > i1.txt; install i1.txt i2.txt; printf %s '0%' >> i2.txt"),
    ).toContain('discount: 10%');
    expect(run("printf 'margin: %d%%' > m1.txt")).toContain('margin: 0%');
    expect(
      run("printf %s 'discount: 1' > p1.txt; printf %s '0%' > /dev/null | tee -a p1.txt"),
    ).not.toContain('discount: 10%');
  });
});

describe('round 18: descriptors and separators', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('keeps the pipe through 2>/dev/null and cuts it at a semicolon or a < redirect', () => {
    expect(run("printf 'discount: ' 2>/dev/null | tee s5.txt; printf '10%%' >> s5.txt")).toContain(
      'discount: 10%',
    );
    expect(
      run("printf 'discount: %d%%' 10; tee s6.txt </dev/null; printf x >> s6.txt"),
    ).not.toContain('discount: 10%');
  });
});

describe('round 19', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('reads tee < file and does not forward a cat with redirected stdout', () => {
    writeFileSync(join(project, 'sfx.txt'), '0%');
    writeFileSync(join(project, 'off.txt'), 'discount: 1');
    expect(run('tee -a off.txt < sfx.txt')).toContain('discount: 10%');
    writeFileSync(join(project, 'ca.txt'), '10%');
    writeFileSync(join(project, 'cb.txt'), 'discount: ');
    expect(run('cat ca.txt > sink.txt | cat >> cb.txt')).not.toContain('discount: 10%');
  });
});

describe('round 20', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it("reads %d of a quoted character, leaves %s arguments undecoded, forwards tee's stdin", () => {
    expect(run("printf 'discount: %d%%' \"'A\" > c1.txt")).toContain('discount: 65%');
    expect(run("printf '%s' 'discount: 10\\t%' > c2.txt")).toContain('discount: 10\\t%');
    writeFileSync(join(project, 'tsrc.txt'), 'discount: 1');
    expect(run("printf safe | tee < tsrc.txt | cat > c3.txt; printf '0%%' >> c3.txt")).toContain(
      'discount: 10%',
    );
  });
});

describe('round 21', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('keeps a numeric file name and only the last stdout redirection', () => {
    expect(run("printf 'discount: 1' > 1; printf '0%%' >> 1")).toContain('discount: 10%');
    expect(run("printf 'discount: 1' > z1.txt; printf '0%%' >> z1.txt > /dev/null")).not.toContain(
      'discount: 10%',
    );
  });
});

describe('round 22', () => {
  it('prints the leading number of a malformed %d argument', () => {
    const texts = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: "printf '%d EUR' 2000junk > j1.txt" },
      cwd: project,
    }).texts;
    expect(texts).toContain('2000 EUR');
  });
});

describe('round 23', () => {
  it('keeps the octal digits of a broken octal %d', () => {
    const texts = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: "printf 'discount: %d%%' 08 > k1.txt" },
      cwd: project,
    }).texts;
    expect(texts).toContain('discount: 0%');
  });
});

describe('round 24', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('reads combined tee flags and a malformed hexadecimal %d', () => {
    expect(run("printf 'discount: 1' > h1.txt; printf '0%%' | tee -ai h1.txt")).toContain(
      'discount: 10%',
    );
    expect(run("printf 'discount: %d%%' 0x10z > h2.txt")).toContain('discount: 16%');
  });
});

describe('round 25', () => {
  it('places stdin where cat has a dash', () => {
    writeFileSync(join(project, 'dash.txt'), 'remise ');
    const texts = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: "printf '10 %%' | cat /dev/null - >> dash.txt" },
      cwd: project,
    }).texts;
    expect(texts).toContain('remise 10 %');
  });
});

describe('round 26', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('handles printf --, unused printf arguments and a copy into a directory', () => {
    expect(run("printf -- 'discount %s%s%%' 1 0 > l1.txt")).toContain('discount 10%');
    expect(run("printf 'discount 2%%' 'discount 10%' > l2.txt").join('|')).not.toContain(
      'discount 10%',
    );
    mkdirSync(join(project, 'dirx'), { recursive: true });
    writeFileSync(join(project, 'pre.txt'), 'discount ');
    expect(run("cp pre.txt dirx; printf '10%%' >> dirx/pre.txt")).toContain('discount 10%');
  });
});

describe('round 27', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).unreadable
      ? ['unreadable']
      : shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('refuses escapes kept inside double quotes and forgets a moved source', () => {
    expect(run('printf "\\x73ecret" > q1.txt')).toContain('unreadable');
    expect(
      run("printf 'discount: ' > mv1.txt; mv mv1.txt mv2.txt; printf '10%%' >> mv1.txt"),
    ).not.toContain('discount: 10%');
  });
});

describe('round 28', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('judges only what writes, and remembers that every > truncates', () => {
    expect(run("printf 'discount: 10%%'; printf safe > r1.txt").join('|')).not.toContain(
      'discount: 10%',
    );
    expect(
      run("printf 'discount: ' > r2.txt; printf safe > r2.txt > r3.txt; printf '10%%' >> r2.txt"),
    ).not.toContain('discount: 10%');
  });
});

describe('round 29', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project }).texts;
  it('reads a dash once and sees a file emptied by its own redirection', () => {
    expect(
      run("printf dis > u1.txt; cat - < u1.txt > u2.txt; printf 'count: 10%%' >> u2.txt").join('|'),
    ).not.toContain('disdis');
    expect(
      run("printf 'discount: ' > u3.txt; cat u3.txt > u3.txt; printf '10%%' >> u3.txt"),
    ).not.toContain('discount: 10%');
  });
});

describe('round 30', () => {
  const run = (command: string) =>
    shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project });
  it('does not judge search patterns, and refuses a copied directory', () => {
    writeFileSync(join(project, 'file9.txt'), 'safe');
    expect(run("sed -i 's/Acme/Other/g' file9.txt").texts.join('|')).not.toContain('Acme');
    expect(run('grep Acme file9.txt; echo safe > out9.txt').texts.join('|')).not.toContain('Acme');
    mkdirSync(join(project, 'srcdir'), { recursive: true });
    expect(run('cp -R srcdir destdir').unreadable).toBe(true);
  });
});

describe('round 31', () => {
  it('does not judge the file name of an ordinary cat copy', () => {
    writeFileSync(join(project, 'Acme.txt'), 'safe');
    const found = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: 'cat Acme.txt > out31.txt' },
      cwd: project,
    });
    expect(found.texts.join('|')).not.toContain('Acme');
    expect(found.texts).toContain('safe');
  });
});

describe('round 32', () => {
  it('does not judge a file that a read-only command in the same line only displays', () => {
    writeFileSync(join(project, 'notes32.txt'), 'Acme');
    const found = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: 'cat notes32.txt; echo safe > res32.txt' },
      cwd: project,
    });
    expect(found.texts.join('|')).not.toContain('Acme');
  });
});

describe('round 33', () => {
  it('does not refuse an unreadable printf format that only prints to the terminal', () => {
    const run = (command: string) =>
      shellCandidates({ tool_name: 'Bash', tool_input: { command }, cwd: project });
    expect(run("printf '%02d\\n' 1; echo compliant > o33.txt").unreadable).toBe(false);
    expect(run("printf '%02d\\n' 1 > o34.txt").unreadable).toBe(true);
  });
});

describe('round 34', () => {
  it('does not refuse a large file only read by another command', () => {
    writeFileSync(join(project, 'large34.txt'), 'x'.repeat(1024 * 1024 + 10));
    const found = shellCandidates({
      tool_name: 'Bash',
      tool_input: { command: 'head -n 1 large34.txt; echo safe > o35.txt' },
      cwd: project,
    });
    expect(found.unreadable).toBe(false);
  });
});
