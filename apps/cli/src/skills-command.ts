/**
 * `ror skills`: the local life of the person's skill library (ADR-0095, ADR-0096).
 *
 *   ror skills list                     the skills this device holds
 *   ror skills new <name>               a new skill folder to fill in; the next sync sends it
 *   ror skills edit <skill>             a working copy outside discovery
 *   ror skills diff <skill>             what changed against the server's revision
 *   ror skills activate <skill>         validate the working copy whole and expose that snapshot
 *   ror skills disable|enable <skill>   leave or return to the tools; the skill stays in the library
 *   ror skills remove <skill>           delete it from the library (every device removes it)
 *   ror skills pool                     the organization's catalogue
 *   ror skills add <entry>              add a catalogue entry to your library (every device receives it)
 *   ror skills promote <skill>          ask a skill manager to put your skill in the catalogue
 */
import {
  activateSkill,
  diffSkill,
  editSkill,
  findSkill,
  listSkills,
  newSkill,
  syncLibrary,
  type Diff,
  type LibraryEnv,
} from './library.js';
import type { LoginContext } from './login.js';
import { call, clientOf, loadEnrolment, type Enrolment } from './session.js';
import { withMachineLockAsync } from './state.js';

const USAGE =
  'usage: ror skills list | new <name> | edit <skill> | diff <skill> | activate <skill> | enable <skill> | disable <skill> | remove <skill> | pool | add <entry> | promote <skill>';
const NOT_LOGGED_IN = 'ROR-E401: not logged in; run `ror login --server <url>`';

const describe = (diff: Diff): string =>
  [
    ...diff.added.map((path) => `  + ${path}`),
    ...diff.removed.map((path) => `  - ${path}`),
    ...diff.changed.map((path) => `  ~ ${path}`),
  ].join('\n') || '  no difference';

export async function runSkills(
  positional: readonly string[],
  env: LibraryEnv,
  enrolment: Enrolment | undefined,
  io: Pick<LoginContext, 'out' | 'err'>,
): Promise<number> {
  const [verb, name] = positional;
  if (verb === 'list') {
    const skills = listSkills();
    if (skills.length === 0) io.out('no skill in this library on this device yet');
    for (const { id, entry } of skills)
      io.out(`${entry.slug}  ${entry.folder}  revision ${String(entry.revision)}  ${id}`);
    return 0;
  }
  if (verb === 'new' && name !== undefined) {
    try {
      const made = newSkill(env, name);
      io.out(`created ${made.dir}\nfill in SKILL.md, then run \`ror sync\` to send it`);
      return 0;
    } catch (error) {
      io.err((error as Error).message);
      return 31;
    }
  }
  if (verb === 'pool' || verb === 'add') {
    if (enrolment === undefined) {
      io.err(NOT_LOGGED_IN);
      return 11;
    }
    const client = clientOf(enrolment, env.fetch);
    if (verb === 'pool') {
      const answered = await call(client, 'GET', '/skill-pool', { query: { limit: 200 } });
      if (answered.status !== 200) {
        io.err(`the server answered ${String(answered.status)}`);
        return 31;
      }
      const body = JSON.parse(answered.text) as {
        items: { slug: string; name: string; version: number; in_my_library: boolean }[];
      };
      if (body.items.length === 0) io.out('the catalogue is empty');
      for (const entry of body.items) {
        io.out(
          `${entry.slug}  v${String(entry.version)}  ${entry.name}${entry.in_my_library ? '  (in your library)' : ''}`,
        );
      }
      return 0;
    }
    if (name === undefined) {
      io.err(USAGE);
      return 31;
    }
    const answered = await call(client, 'POST', `/skill-pool/${encodeURIComponent(name)}/library`);
    if (answered.status !== 201) {
      io.err(
        answered.status === 409
          ? `you already have a skill called "${name}"`
          : `the server answered ${String(answered.status)}`,
      );
      return 31;
    }
    const outcome = await withMachineLockAsync(() => syncLibrary(env, enrolment));
    for (const line of outcome.lines) io.out(line);
    return outcome.code;
  }
  if (name === undefined) {
    io.err(USAGE);
    return 31;
  }
  const ref = findSkill(name);
  if (ref === undefined) {
    io.err(`no skill "${name}" on this device: \`ror skills list\``);
    return 31;
  }
  switch (verb) {
    case 'edit': {
      io.out(
        `working copy: ${editSkill(env, ref)}\nedit it, \`ror skills diff ${ref.entry.slug}\` to look, \`ror skills activate ${ref.entry.slug}\` to use it`,
      );
      return 0;
    }
    case 'diff': {
      const result = diffSkill(env, ref);
      io.out(
        `in the tool's folder, against the server's revision ${String(ref.entry.revision)}:\n${describe(result.exposed)}`,
      );
      if (result.work !== undefined) io.out(`in the working copy:\n${describe(result.work)}`);
      return 0;
    }
    case 'activate': {
      try {
        const result = activateSkill(env, ref);
        if (!result.ok) {
          io.err(
            `not activated, your working copy is untouched: ${[...new Set(result.findings.map((each) => each.code))].join(', ')}`,
          );
          return 31;
        }
      } catch (error) {
        io.err((error as Error).message);
        return 31;
      }
      io.out(
        `${ref.entry.folder} now holds a snapshot of your working copy; \`ror sync\` sends it`,
      );
      return 0;
    }
    case 'promote': {
      if (enrolment === undefined) {
        io.err(NOT_LOGGED_IN);
        return 11;
      }
      const answered = await call(
        clientOf(enrolment, env.fetch),
        'POST',
        `/library/skills/${ref.id}/promotion`,
      );
      if (answered.status !== 201) {
        let problem: { detail?: string; code?: string } = {};
        try {
          problem = JSON.parse(answered.text) as typeof problem;
        } catch {
          // not a problem document: the status says enough
        }
        io.err(
          `not requested (${problem.code ?? String(answered.status)}): ${problem.detail ?? ''}`,
        );
        return 31;
      }
      io.out(`${ref.entry.slug}: a skill manager will read exactly this revision and decide`);
      return 0;
    }
    case 'enable':
    case 'disable':
    case 'remove': {
      if (enrolment === undefined) {
        io.err(NOT_LOGGED_IN);
        return 11;
      }
      const client = clientOf(enrolment, env.fetch);
      const answered =
        verb === 'remove'
          ? await call(client, 'DELETE', `/library/skills/${ref.id}`)
          : await call(client, 'PUT', `/library/skills/${ref.id}/enabled`, {
              body: { enabled: verb === 'enable' },
            });
      if (answered.status !== (verb === 'remove' ? 204 : 200)) {
        io.err('the server refused (or is unreachable); nothing changed');
        return 31;
      }
      // the tool's folder follows at once, not at the next timer
      const outcome = await withMachineLockAsync(() => syncLibrary(env, enrolment));
      for (const line of outcome.lines) io.out(line);
      return outcome.code;
    }
    default:
      io.err(USAGE);
      return 31;
  }
}

/** `ror skills …`: the verb. */
export async function skillsVerb(args: readonly string[], context: LoginContext): Promise<number> {
  const env: LibraryEnv = { fetch: context.fetch ?? fetch, now: () => new Date() };
  return runSkills(args, env, loadEnrolment(context), context);
}
