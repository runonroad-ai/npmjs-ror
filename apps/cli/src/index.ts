#!/usr/bin/env node
import { homedir } from 'node:os';

import { run } from './cli.js';

process.exitCode = await run(process.argv.slice(2), {
  // shortcut: no verb reads the environment yet; the first one goes through packages/config.
  env: {},
  home: homedir(),
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
});
