import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { renderJsonSchema, SCHEMA_ID, SCHEMA_PATH } from './json-schema.js';

describe('the committed JSON Schema', () => {
  it('is what the Zod schema generates', async () => {
    // Consumers that are not TypeScript read the committed file. If it drifts,
    // they validate against a contract we no longer honour.
    const committed = await readFile(SCHEMA_PATH, 'utf8');
    expect(committed).toBe(renderJsonSchema());
  });

  it('carries a stable identifier', () => {
    expect(JSON.parse(renderJsonSchema())).toMatchObject({ $id: SCHEMA_ID });
  });

  it('renders identically twice', () => {
    expect(renderJsonSchema()).toBe(renderJsonSchema());
  });

  it('refuses unknown properties, like the Zod schema does', () => {
    const schema = JSON.parse(renderJsonSchema()) as { additionalProperties?: boolean };
    expect(schema.additionalProperties).toBe(false);
  });
});
