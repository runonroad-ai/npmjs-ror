#!/usr/bin/env node
/**
 * The entry of `ror hook`, apart from main.ts so that a tool call does not pay
 * for the schema libraries `ror sync` needs. Reads the tool call on stdin,
 * prints a deny on stdout, or nothing for an allow.
 *
 * The compiled code is cached between calls (Node's compile cache): it takes
 * about 12 ms off a start. Node's own start-up (about 30 ms at the median on
 * the machine this was measured on) is the floor; see ADR-0085.
 */
import { readFileSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { clientEnvironment } from '@runonroad/config/client';

const environment = clientEnvironment();
try {
  enableCompileCache(
    join(environment.rorHome ?? join(environment.home ?? homedir(), '.runonroad'), 'node-cache'),
  );
} catch {
  // a cache that cannot be written only costs time
}

// `--target codex` / `--event beforeShellExecution`, written by `ror install` into each tool's hook entry
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const requested = flag('--target');
const target =
  requested === 'codex' || requested === 'cursor' || requested === 'claude_code'
    ? requested
    : 'claude_code';

let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {
  // no stdin: runHook refuses what it cannot read
}
try {
  const { runHook } = await import('./hook.js');
  const { stdout, exitCode } = runHook(input, new Date(), target, flag('--event'));
  if (stdout !== '') process.stdout.write(`${stdout}\n`);
  process.exitCode = exitCode;
} catch (error) {
  // Codex and Cursor let a call through when a hook fails with anything but 2: a crash is a refusal
  process.stderr.write(`RunOnRoad could not check this call: ${(error as Error).message}\n`);
  process.exitCode = 2;
}
