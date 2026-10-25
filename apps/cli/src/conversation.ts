/**
 * The conversation with the AI, checked against content rules (ADR-0088): what the person
 * writes (prompt), what the AI is about to write (file_write) and what it said (answer).
 *
 * Code decides alone only on an explicit violation (content.ts). For everything it cannot
 * decide, it makes the conversation's OWN AI decide: the applicable rules and a short protocol
 * are put in front of it at every prompt, and a doubtful spot is pointed out to it. There is no
 * second model. Nothing here leaves the device.
 */
import { check, type ContentRule, type ContentScope, type Finding } from '@runonroad/content-rules';

/** What the person is told and what the AI is told, as plain text. */
export interface Verdict {
  readonly violations: readonly Finding[];
  readonly doubts: readonly Finding[];
}

/** The injected context may not grow without bound: past this a policy is refused (ADR-0088). */
export const MAX_CONTEXT_BYTES = 24 * 1024;

export function liveContent(
  rules: readonly ContentRule[],
  derogations: readonly { rule_id: string; expires_at_ms: number }[],
  nowMs: number,
): ContentRule[] {
  const lifted = new Set(
    derogations.filter((lease) => lease.expires_at_ms > nowMs).map((lease) => lease.rule_id),
  );
  return rules.filter((rule) => !(rule.decision === 'ask' && lifted.has(rule.id)));
}

export function verdictOf(
  rules: readonly ContentRule[],
  scope: ContentScope,
  text: string,
): Verdict {
  const findings = rules
    .filter((rule) => rule.scopes.includes(scope))
    .flatMap((rule) => check(rule, text));
  return {
    violations: findings.filter((finding) => finding.kind === 'violation'),
    doubts: findings.filter((finding) => finding.kind === 'ambiguous'),
  };
}

/** An authored alternative that would itself break a rule is not offered (ADR-0088). */
function usable(alternative: string, rules: readonly ContentRule[]): boolean {
  return rules.every((rule) =>
    check(rule, alternative).every((finding) => finding.kind !== 'violation'),
  );
}

/** "Blocked by rule X: why. Alternatives: a; b." and, for Ask-first, how to get past it. */
export function explain(finding: Finding, rules: readonly ContentRule[] = []): string {
  const { rule } = finding;
  const offered = rule.alternatives.filter((alternative) => usable(alternative, rules));
  const alternatives = offered.length > 0 ? ` Alternatives: ${offered.join('; ')}.` : '';
  const lease =
    rule.decision === 'ask'
      ? ` This needs a derogation: tell the person to run \`ror derogation request ${rule.id} --reason "<why>"\` and wait for the approval.`
      : '';
  return `Blocked by RunOnRoad rule ${rule.id}: ${rule.reason} (seen: "${finding.seen}").${alternatives}${lease}`;
}

export function blockReason(
  violations: readonly Finding[],
  rules: readonly ContentRule[] = [],
): string {
  // one explanation per rule, the first sighting of each
  const seen = new Set<string>();
  return violations
    .filter((finding) => (seen.has(finding.rule.id) ? false : (seen.add(finding.rule.id), true)))
    .map((finding) => explain(finding, rules))
    .join(' ');
}

/** The spots code could not decide, for the AI to look at. */
export function doubtSignal(doubts: readonly Finding[]): string {
  const seen = new Set<string>();
  const lines = doubts
    .filter((finding) => (seen.has(finding.rule.id) ? false : (seen.add(finding.rule.id), true)))
    .map(
      (finding) =>
        `- Rule ${finding.rule.id} ("${finding.rule.text}"): this text may concern it ("${finding.seen}"). Decide whether the value or term really is the rule's subject; if it is, refuse and explain.`,
    );
  return lines.length === 0 ? '' : `RunOnRoad could not decide by itself:\n${lines.join('\n')}`;
}

const PROTOCOL = [
  'RunOnRoad governance applies to this conversation. Before you answer or call a tool, check the request, your answer and anything you write against the rules below.',
  "Apply each rule only where it says it applies. Bind every value to its subject: a number only counts for a rule when it is that rule's subject (a 10 % productivity gain is not a 10 % discount).",
  'If a rule is violated, refuse the prohibited part, name the rule, explain why, and offer the compliant alternatives. For an Ask-first rule, stop: it needs a derogation.',
  'If you cannot tell whether a rule applies, ask one short question. Check what you are about to write before you write it.',
].join('\n');

const trim = (text: string, size: number): string =>
  text.length <= size ? text : `${text.slice(0, size - 1)}…`;

/** What the centre's reviewed fiche tells the AI about one rule: its meaning and a few cases of each kind. */
function ficheLines(rule: ContentRule): string {
  const fiche = rule.fiche;
  if (fiche === undefined) return '';
  const cases = (label: string, list: readonly string[]): string =>
    list.length === 0
      ? ''
      : ` ${label}: ${list
          .slice(0, 2)
          .map((text) => `"${trim(text, 120)}"`)
          .join(', ')}.`;
  return ` Meaning: ${trim(fiche.interpretation, 300)}${cases('Breaks it', fiche.examples.violation)}${cases('Fine', fiche.examples.compliant)}${cases('Not about this rule', fiche.examples.other_subject)}`;
}

/** The rules the AI must hold in mind: every content rule, never a selection that could drop one. */
export function injectionContext(rules: readonly ContentRule[]): string {
  if (rules.length === 0) return '';
  const where: Record<string, string> = {
    prompt: 'the person’s requests',
    answer: 'your answers',
    file_write: 'what you write in files',
  };
  const lines = rules.map((rule) => {
    const applies = rule.scopes.map((scope) => where[scope] ?? scope).join(', ');
    const offered = rule.alternatives.filter((alternative) => usable(alternative, rules));
    const alternatives = offered.length > 0 ? ` Alternatives: ${offered.join('; ')}.` : '';
    return `- [${rule.decision === 'ask' ? 'ASK FIRST' : 'FORBIDDEN'}] ${rule.id} (${rule.topic}; applies to: ${applies}): ${rule.text}${ficheLines(rule)}${alternatives}`;
  });
  return `${PROTOCOL}\n\nRules:\n${lines.join('\n')}`;
}

export const contextSize = (rules: readonly ContentRule[]): number =>
  Buffer.byteLength(injectionContext(rules), 'utf8');
