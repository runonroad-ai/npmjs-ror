/**
 * The verb dispatch of `ror` (ADR-0084, SPEC-007), kept apart from `index.ts` so a test can
 * run it without the process exiting.
 *
 * `help`, `login`, `logout` and `version` are wired: `mcp` (#688) arrives with its
 * Stories. The help page is printed from `VERBS`, so it never announces a verb the
 * dispatch does not run.
 */
import { derogation } from './derogation-command.js';
import { acceptedBy, unknownFlags } from './flags.js';
import { login, type LoginContext } from './login.js';
import { logout } from './logout.js';
import { mcp } from './mcp.js';
import { skillsVerb } from './skills-command.js';
import { installVerb, statusVerb, syncVerb, uninstallVerb } from './sync-command.js';
import { RorError } from './token-store.js';
import { version } from './version.js';

/** Where a verb writes: stdout and stderr in production, buffers in tests. */
export interface Output {
  out: (line: string) => void;
  err: (line: string) => void;
}

interface Verb {
  summary: string;
  run: (args: readonly string[], context: LoginContext) => number | Promise<number>;
}

const VERBS: Readonly<Record<string, Verb>> = {
  help: { summary: 'Prints this page. Also what a bare `ror` prints.', run: (_, c) => help(c) },
  derogation: {
    summary: 'Asks to lift an Ask-first rule (request, list, show, answer); never decides.',
    run: derogation,
  },
  login: { summary: 'Enrols this device: approve the code it shows in the console.', run: login },
  logout: { summary: 'Revokes this device on the server and removes its token.', run: logout },
  sync: {
    summary: 'Fetches and applies the governance of this project (and your skill library).',
    run: syncVerb,
  },
  mcp: {
    summary:
      'Relays the MCP server of RunOnRoad to a tool over stdio (an agent or personal token: RUNONROAD_TOKEN).',
    run: mcp,
  },
  skills: {
    summary: 'Your skill library on this device: list, new, edit, diff, activate, pool, add.',
    run: skillsVerb,
  },
  status: {
    summary: 'What is applied, what drifted, and what this device enforces.',
    run: statusVerb,
  },
  install: {
    summary:
      'Wires the sync into Claude Code (a SessionStart hook) and, with --timer, a refresh timer.',
    run: installVerb,
  },
  uninstall: {
    summary: 'Takes back everything ror wrote for this project.',
    run: uninstallVerb,
  },
  version: {
    summary: 'Prints the version, its channel and the sha256 of this build.',
    run: version,
  },
};

function help(output: Output): number {
  const width = Math.max(...Object.keys(VERBS).map((name) => name.length)) + 2;
  output.out('ror — the RunOnRoad client\n\nUsage: ror <command>\n\nCommands:');
  for (const [name, verb] of Object.entries(VERBS)) {
    output.out(`  ${name.padEnd(width)}${verb.summary}`);
  }
  return 0;
}

/** Runs `ror` on its arguments (without `node` and the script) and returns the exit code. */
export async function run(argv: readonly string[], context: LoginContext): Promise<number> {
  const output = context;
  const [command = 'help', ...rest] = argv;
  const name = command === '--help' || command === '-h' ? 'help' : command;
  const verb = VERBS[name];
  if (verb === undefined) {
    output.err(`Unknown command: ${command}\n`);
    help({ out: output.err, err: output.err });
    return 1;
  }

  const unknown = unknownFlags(name, rest);
  if (unknown.length > 0) {
    const accepted = acceptedBy(name);
    output.err(`Unknown option for \`${name}\`: ${unknown.join(', ')}`);
    output.err(`Accepted: ${accepted.length > 0 ? accepted.join(', ') : 'none'}`);
    return 1;
  }

  try {
    return await verb.run(rest, context);
  } catch (error) {
    if (!(error instanceof RorError)) throw error;
    output.err(error.message);
    return error.code.startsWith('ROR-E0') ? 2 : 1;
  }
}
