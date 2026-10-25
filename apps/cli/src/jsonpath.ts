/** RFC 6901 pointers over plain JSON, enough for `merge_json` (SPEC-006 §2). */
import { isDeepStrictEqual } from 'node:util';

export type Json = Record<string, unknown>;

export function segments(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  if (!pointer.startsWith('/')) throw new Error(`"${pointer}" is not a JSON pointer`);
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function getAt(root: Json, pointer: string): unknown {
  let current: unknown = root;
  for (const part of segments(pointer)) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** Sets the value, creating the objects on the way. Returns false if a parent is not an object. */
export function setAt(root: Json, pointer: string, value: unknown): boolean {
  const parts = segments(pointer);
  const last = parts.pop();
  if (last === undefined) return false;
  let current: Json = root;
  for (const part of parts) {
    const next = current[part];
    if (next === undefined) current[part] = {};
    else if (!isObject(next)) return false;
    current = current[part] as Json;
  }
  current[last] = value;
  return true;
}

/** Removes the key, and the objects it leaves empty on the way up. */
export function deleteAt(root: Json, pointer: string): void {
  const parts = segments(pointer);
  const chain: Json[] = [root];
  for (const part of parts.slice(0, -1)) {
    const next = (chain.at(-1) as Json)[part];
    if (!isObject(next)) return;
    chain.push(next);
  }
  const last = parts.at(-1);
  if (last === undefined) return;
  Reflect.deleteProperty(chain.at(-1) as Json, last);
  for (let depth = chain.length - 1; depth > 0; depth -= 1) {
    const owner = chain[depth] as Json;
    if (Object.keys(owner).length > 0) break;
    Reflect.deleteProperty(chain[depth - 1] as Json, parts[depth - 1] as string);
  }
}

/** Appends the elements not already there; returns the ones it added. */
export function appendUnique(root: Json, pointer: string, elements: readonly unknown[]): unknown[] {
  const existing = getAt(root, pointer);
  const list: unknown[] = Array.isArray(existing) ? [...(existing as unknown[])] : [];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(`"${pointer}" holds something that is not a list`);
  }
  const added: unknown[] = [];
  for (const element of elements) {
    if (list.some((item) => isDeepStrictEqual(item, element))) continue;
    list.push(element);
    added.push(element);
  }
  if (added.length > 0 || existing === undefined) setAt(root, pointer, list);
  return added;
}

export const sameJson = isDeepStrictEqual;
