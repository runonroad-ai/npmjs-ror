/**
 * `ror install`: wire the sync into Claude Code (a SessionStart hook in the
 * user's settings, or the machine-wide managed settings that a user cannot
 * override) and, on Linux, a systemd user timer that refreshes independently
 * of any tool. Everything we add carries MARK so it can be removed exactly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clientEnvironment } from '@runonroad/config/client';

import { applyManaged, MANAGED_HEADER, uninstallManaged, type Layer } from './managed.js';
import { defaultHome } from './paths.js';
import { rorHome } from './state.js';

export const MARK = 'runonroad-managed';

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}
interface Settings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

const mainPath = (): string => fileURLToPath(new URL('./main.js', import.meta.url));
const hookPath = (): string => fileURLToPath(new URL('./hook-main.js', import.meta.url));

/** The command Claude Code runs for a hook; MARK lets us find our own entry again. */
export const hookCommand = (verb: 'sync --from-hook' | 'hook' = 'sync --from-hook'): string =>
  verb === 'hook'
    ? `"${process.execPath}" "${hookPath()}" # ${MARK}`
    : `"${process.execPath}" "${mainPath()}" ${verb} # ${MARK}`;

/**
 * The command a tool runs for ror, per target. `--ror-managed` marks our entry in files we
 * share with the user (Codex's hooks.json); Claude Code keeps its shell comment.
 */
export function targetCommand(
  target: 'claude_code' | 'codex' | 'cursor',
  verb: 'hook' | 'sync',
  event?: string,
): string {
  if (target === 'claude_code') return hookCommand(verb === 'hook' ? 'hook' : 'sync --from-hook');
  const entry =
    verb === 'hook'
      ? `"${process.execPath}" "${hookPath()}" --target ${target}${event === undefined ? '' : ` --event ${event}`}`
      : `"${process.execPath}" "${mainPath()}" sync --from-hook --target ${target}`;
  return `${entry} --ror-managed`;
}

/** Where the project's native settings are written by a bundle (git-ignored by convention). */
export const SETTINGS_FILE = '${project}/.claude/settings.local.json';

/** Where the machine-wide managed settings of Claude Code live on this OS. */
export const managedSettingsPath = (): string => settingsPath(true);

export function settingsPath(managed: boolean): string {
  if (managed) {
    if (platform() === 'darwin')
      return '/Library/Application Support/ClaudeCode/managed-settings.json';
    if (platform() === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
    return '/etc/claude-code/managed-settings.json';
  }
  return join(
    clientEnvironment().claudeConfigDir ?? join(defaultHome(), '.claude'),
    'settings.json',
  );
}

const read = (path: string): Settings =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Settings) : {};

const ours = (entry: HookEntry): boolean =>
  (entry.hooks ?? []).some((hook) => hook.command?.includes(MARK) === true);

/**
 * Where ror's locks of `install` live, and the roots they serve (ADR-0119): the settings of the user
 * (inside `${home}`, or `CLAUDE_CONFIG_DIR` when it is set) or the machine-wide ones, and the units
 * of the refresh timer. Everything `ror install` writes goes through the managed writer.
 */
function hookLayer(managed: boolean): { layer: Layer; path: string } {
  const lockPath = join(rorHome(), 'user', managed ? '_install.managed.json' : '_install.json');
  const config = clientEnvironment().claudeConfigDir;
  if (managed) {
    return {
      layer: { roots: { managed_settings: dirname(settingsPath(true)) }, lockPath },
      path: '${managed_settings}/managed-settings.json',
    };
  }
  return config === undefined
    ? { layer: { roots: { home: defaultHome() }, lockPath }, path: '${home}/.claude/settings.json' }
    : {
        layer: { roots: { claude_config: config }, lockPath },
        path: '${claude_config}/settings.json',
      };
}

export function installHook(managed: boolean): string {
  const { layer, path } = hookLayer(managed);
  applyManaged(
    [
      {
        op: 'merge_json',
        path,
        pointer: '/hooks/SessionStart',
        value: [
          { matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: hookCommand() }] },
        ],
        strategy: 'append_unique',
        owner: '_runonroad',
      },
    ],
    layer,
    { extended: true, retire: 'unchanged-only' },
  );
  return settingsPath(managed);
}

export function removeHook(managed: boolean): boolean {
  const { layer } = hookLayer(managed);
  if (!existsSync(layer.lockPath)) return false;
  return uninstallManaged(layer).removed.length > 0;
}

export function hookInstalled(managed: boolean): boolean {
  const path = settingsPath(managed);
  return existsSync(path) && (read(path).hooks?.['SessionStart'] ?? []).some(ours);
}

// ------------------------------------------------------------------ timer

/** The refresh runs every 15 minutes, which is also the published delay for a lease to end on the native files (ADR-0087). */
export const REFRESH_MINUTES = 15;

const agentDirectory = (): string => join(homedir(), 'Library', 'LaunchAgents');
export const LAUNCH_LABEL = 'com.runonroad.ror-sync';
export const TASK_NAME = 'RunOnRoad sync';

const syncAllCommand = (): string => `"${process.execPath}" "${mainPath()}" sync --all`;

/** The macOS LaunchAgent: loaded at login, run every 15 minutes. */
export function launchAgentPlist(): string {
  const arguments_ = [process.execPath, mainPath(), 'sync', '--all']
    .map((part) => `    <string>${part.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED_HEADER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${arguments_}
  </array>
  <key>StartInterval</key>
  <integer>${String(REFRESH_MINUTES * 60)}</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

/** The Windows Task Scheduler command, as an argument list (never a shell string). */
export const scheduledTaskArguments = (): string[] => [
  '/Create',
  '/F',
  '/SC',
  'MINUTE',
  '/MO',
  String(REFRESH_MINUTES),
  '/TN',
  TASK_NAME,
  '/TR',
  syncAllCommand(),
];

const timerLayer = (): Layer => ({
  roots: { home: defaultHome() },
  lockPath: join(rorHome(), 'user', '_install.timer.json'),
});

const unitPath = (name: string): string => `\${home}/.config/systemd/user/${name}`;

export function installTimer(os: NodeJS.Platform = platform()): string {
  if (os === 'darwin') {
    applyManaged(
      [
        {
          op: 'write_file',
          path: '${home}/Library/LaunchAgents/ror-sync.plist',
          content: launchAgentPlist(),
        },
      ],
      timerLayer(),
      { extended: true, retire: 'unchanged-only' },
    );
    const file = join(agentDirectory(), 'ror-sync.plist');
    try {
      execFileSync('launchctl', ['unload', file], { stdio: 'ignore' });
    } catch {
      // not loaded yet
    }
    try {
      execFileSync('launchctl', ['load', '-w', file], { stdio: 'ignore' });
      return `LaunchAgent ${LAUNCH_LABEL} loaded (every ${String(REFRESH_MINUTES)} minutes)`;
    } catch {
      return `LaunchAgent written to ${file}, but launchctl could not load it: run \`launchctl load -w "${file}"\``;
    }
  }
  if (os === 'win32') {
    try {
      execFileSync('schtasks', scheduledTaskArguments(), { stdio: 'ignore' });
      return `scheduled task "${TASK_NAME}" created (every ${String(REFRESH_MINUTES)} minutes)`;
    } catch {
      return `could not create the scheduled task: run \`schtasks ${scheduledTaskArguments()
        .map((a) => `"${a}"`)
        .join(' ')}\``;
    }
  }
  applyManaged(
    [
      {
        op: 'write_file',
        path: unitPath('ror-sync.service'),
        content: `# ${MANAGED_HEADER}\n[Unit]\nDescription=RunOnRoad sync\n\n[Service]\nType=oneshot\nExecStart=${syncAllCommand()}\n`,
      },
      {
        op: 'write_file',
        path: unitPath('ror-sync.timer'),
        content: `# ${MANAGED_HEADER}\n[Unit]\nDescription=RunOnRoad sync every ${String(REFRESH_MINUTES)} minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${String(REFRESH_MINUTES)}min\n\n[Install]\nWantedBy=timers.target\n`,
      },
    ],
    timerLayer(),
    { extended: true, retire: 'unchanged-only' },
  );
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'ror-sync.timer'], { stdio: 'ignore' });
    return `timer ror-sync.timer enabled (every ${String(REFRESH_MINUTES)} minutes)`;
  } catch {
    return 'timer files written, but systemctl --user could not enable them: run `systemctl --user enable --now ror-sync.timer`';
  }
}

export function removeTimer(os: NodeJS.Platform = platform()): boolean {
  if (os === 'win32') {
    try {
      execFileSync('schtasks', ['/Delete', '/F', '/TN', TASK_NAME], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  const layer = timerLayer();
  if (!existsSync(layer.lockPath)) return false;
  if (os === 'darwin') {
    try {
      execFileSync('launchctl', ['unload', join(agentDirectory(), 'ror-sync.plist')], {
        stdio: 'ignore',
      });
    } catch {
      // may already be unloaded
    }
  } else {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', 'ror-sync.timer'], {
        stdio: 'ignore',
      });
    } catch {
      // the unit may already be stopped
    }
  }
  return uninstallManaged(layer).removed.length > 0;
}
