/**
 * The flags of `ror`, declared once (ported from RunOnRoadMCP `apps/cli/src/drapeaux.ts`).
 *
 * The list is closed: a flag missing here is refused, never ignored. An ignored flag lets a
 * command silently do something other than what was asked, and a script still passing an old
 * name must stop rather than change meaning.
 */
import { RorError } from './token-store.js';

/** Accepted by every verb. */
export const GLOBAL_FLAGS: readonly string[] = [];

/** The flags of one verb, on top of the global ones. A verb missing here takes only those. */
export const VERB_FLAGS: Readonly<Record<string, readonly string[]>> = {
  login: ['--server', '--org', '--non-interactive'],
  logout: ['--server'],
};

/** Everything a verb accepts: its own flags plus the global ones. */
export const acceptedBy = (verb: string): readonly string[] => [
  ...GLOBAL_FLAGS,
  ...(VERB_FLAGS[verb] ?? []),
];

/** The flags this verb does not know, in the order they were typed. */
export function unknownFlags(verb: string, args: readonly string[]): string[] {
  const known = acceptedBy(verb);
  return args.filter((a) => a.startsWith('-') && a !== '-' && !known.includes(a));
}

/** The value after `flag`, or `undefined` when the flag is absent. A flag with no value is refused. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new RorError('ROR-E001', `${flag} needs a value: ${flag} <value>.`);
  }
  return value;
}
