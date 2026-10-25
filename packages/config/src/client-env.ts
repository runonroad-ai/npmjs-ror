/**
 * What the `ror` client reads from the environment of a developer's machine
 * (ADR-0037 §1: the one place production code reads it). These are not
 * platform variables of the registry: they name where the client keeps its
 * state and where the tools it configures keep theirs, so this module has no
 * secret name in it and is safe to bundle into the client.
 */
export interface ClientEnvironment {
  /** RUNONROAD_HOME: where `ror` keeps its enrolment, cache and lock (default ~/.runonroad). */
  readonly rorHome: string | undefined;
  /** RUNONROAD_API_URL: the server `ror login` talks to when --api is absent. */
  readonly apiUrl: string | undefined;
  readonly home: string | undefined;
  /** CLAUDE_CONFIG_DIR, as Claude Code itself reads it. */
  readonly claudeConfigDir: string | undefined;
  /** CODEX_HOME, as Codex itself reads it. */
  readonly codexHome: string | undefined;
  /** CLAUDE_PROJECT_DIR, set by Claude Code for its hooks. */
  readonly claudeProjectDir: string | undefined;
  /** RUNONROAD_TOKEN: an agent or personal token `ror mcp` sends unchanged (ADR-0083 point 5, ADR-0087). */
  readonly token: string | undefined;
}

/** Read at each call, not once: a test or a wrapper may change the environment between two. */
export function clientEnvironment(): ClientEnvironment {
  const { env } = process;
  return {
    rorHome: env['RUNONROAD_HOME'],
    apiUrl: env['RUNONROAD_API_URL'],
    home: env['HOME'],
    claudeConfigDir: env['CLAUDE_CONFIG_DIR'],
    codexHome: env['CODEX_HOME'],
    claudeProjectDir: env['CLAUDE_PROJECT_DIR'],
    token: env['RUNONROAD_TOKEN'],
  };
}

/** The repository variables `git` obeys from the environment: `ror` runs git for its own discovery without them. */
const GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];

/** The environment a child `git` of `ror` runs with: the caller's, minus the variables that pick a repository. */
export function gitSafeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !GIT_VARIABLES.includes(entry[0]),
    ),
  );
}
