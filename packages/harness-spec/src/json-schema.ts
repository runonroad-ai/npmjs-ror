/**
 * The JSON Schema of the subset, generated from the Zod schema and committed.
 *
 * It is committed because consumers that are not TypeScript — an editor, a
 * validator in CI, a customer's own tooling — need the contract without
 * running our code. It is generated because two hand-maintained descriptions
 * of the same thing always end up describing different things.
 */
import { z } from 'zod';

import { RhsDocumentSchema } from './schema.js';

export const SCHEMA_PATH = new URL('../schema/rhs-v1.subset.schema.json', import.meta.url);

export const SCHEMA_ID = 'https://runonroad.dev/schema/rhs-v1.subset.schema.json';

/** Stable output: sorted keys, so a real change shows as a small diff. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    );
  }
  return value;
}

export function renderJsonSchema(): string {
  const generated = z.toJSONSchema(RhsDocumentSchema, { io: 'input' });
  const document = sortKeys({
    ...generated,
    $id: SCHEMA_ID,
    title: 'RunOnRoad Harness Spec v1 — preamble and four blocks subset',
  });
  return `${JSON.stringify(document, null, 2)}\n`;
}
