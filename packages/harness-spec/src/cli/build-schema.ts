#!/usr/bin/env node
/** Regenerates the committed JSON Schema. Run by `pnpm golden:update`. */
import { writeFile } from 'node:fs/promises';

import { renderJsonSchema, SCHEMA_PATH } from '../json-schema.js';

const schema = renderJsonSchema();
await writeFile(SCHEMA_PATH, schema, 'utf8');
console.log(`harness-spec: wrote ${String(schema.split('\n').length)} lines of JSON Schema`);
