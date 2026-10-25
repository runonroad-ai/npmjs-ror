#!/usr/bin/env node
import { homedir } from 'node:os';

import { clientEnvironment } from '@runonroad/config/client';

import { run } from './cli.js';

process.exitCode = await run(process.argv.slice(2), {
  // `ror mcp` is the first verb to read the environment, through packages/config (ADR-0037 point 1).
  env: { RUNONROAD_TOKEN: clientEnvironment().token },
  home: homedir(),
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
});
