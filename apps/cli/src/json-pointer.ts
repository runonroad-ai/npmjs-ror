/**
 * RFC 6901 pointers over plain JSON objects, for `merge_json` (SPEC-006 §2, ADR-0119 point 3).
 * Strict: only `~0` and `~1` escapes, no empty pointer or empty segment, objects only (a list is
 * never walked through, only a terminal `append_unique` target), own properties only, and the
 * keys that reach `Object.prototype` are refused. No file access: the managed writer reads and writes.
 */
import { isDeepStrictEqual } from 'node:util';

export type JsonObject = Record<string, unknown>;

/** The pointer is not one `ror` follows. */
export class PointerError extends Error {
  override readonly name = 'PointerError';
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const own = (object: JsonObject, key: string): boolean => Object.hasOwn(object, key);

/** The decoded segments of a pointer, or a refusal. */
export function segmentsOf(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new PointerError(`"${pointer}" is not a JSON pointer`);
  return pointer
    .slice(1)
    .split('/')
    .map((raw) => {
      if (raw === '') throw new PointerError(`"${pointer}" has an empty segment`);
      if (/~(?![01])/u.test(raw)) throw new PointerError(`"${pointer}" has an invalid escape`);
      const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (FORBIDDEN.has(segment)) throw new PointerError(`"${pointer}" names a reserved key`);
      return segment;
    });
}

/** The value a pointer names, walking objects through their own properties only. */
export function getAt(root: JsonObject, pointer: string): unknown {
  let current: unknown = root;
  for (const segment of segmentsOf(pointer)) {
    if (!isObject(current) || !own(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

const define = (object: JsonObject, key: string, value: unknown): void => {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

/**
 * Sets the value, creating the objects on the way. Returns the pointers of the objects it created
 * (so the undo removes those and no other), or `undefined` when a parent is not an object.
 */
export function setAt(root: JsonObject, pointer: string, value: unknown): string[] | undefined {
  const parts = segmentsOf(pointer);
  const last = parts.pop();
  if (last === undefined) return undefined;
  const created: string[] = [];
  let current: JsonObject = root;
  let path = '';
  for (const part of parts) {
    path += `/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (!own(current, part)) {
      const next: JsonObject = {};
      define(current, part, next);
      created.push(path);
      current = next;
    } else {
      const next = current[part];
      if (!isObject(next)) return undefined;
      current = next;
    }
  }
  define(current, last, value);
  return created;
}

/** Removes the key, then the objects in `createdParents` that this leaves empty, deepest first. */
export function deleteAt(
  root: JsonObject,
  pointer: string,
  createdParents: readonly string[] = [],
): void {
  const parts = segmentsOf(pointer);
  const chain: JsonObject[] = [root];
  for (const part of parts.slice(0, -1)) {
    const holder = chain.at(-1) as JsonObject;
    const next = own(holder, part) ? holder[part] : undefined;
    if (!isObject(next)) return;
    chain.push(next);
  }
  const last = parts.at(-1);
  if (last === undefined) return;
  Reflect.deleteProperty(chain.at(-1) as JsonObject, last);
  for (let depth = chain.length - 1; depth > 0; depth -= 1) {
    const owner = chain[depth] as JsonObject;
    const at = `/${parts
      .slice(0, depth)
      .map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1'))
      .join('/')}`;
    if (Object.keys(owner).length > 0 || !createdParents.includes(at)) break;
    Reflect.deleteProperty(chain[depth - 1] as JsonObject, parts[depth - 1] as string);
  }
}

export const sameJson = isDeepStrictEqual;

/** Two pointers overlap when one is the other or a parent of it (`/a` and `/a/b`). */
export function overlaps(a: string, b: string): boolean {
  const left = segmentsOf(a);
  const right = segmentsOf(b);
  const shortest = Math.min(left.length, right.length);
  return left.slice(0, shortest).every((part, index) => part === right[index]);
}
