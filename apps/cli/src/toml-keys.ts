/**
 * What the managed writer needs to know of a user's TOML to place a block of top-level keys
 * (ADR-0119 point 3 bis): the key and table paths a text defines, and whether a block would
 * define one of them again. Not a full parser: it reads what `ror` must not collide with.
 * No file access.
 */

/** TOML: a dotted key outside any table must come before the first `[table]`, or it would belong to it. */
export const isTopLevelToml = (path: string, content: string): boolean =>
  path.endsWith('.toml') &&
  !(content.split('\n').find((line) => line.trim() !== '' && !line.trim().startsWith('#')) ?? '[')
    .trimStart()
    .startsWith('[');

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

/** One TOML escape sequence at the start of `source` (which begins with a backslash): its text and its length. */
function decodeEscape(source: string): { text: string; length: number } {
  const kind = source[1] ?? '';
  const simple = SIMPLE_ESCAPES[kind];
  if (simple !== undefined) return { text: simple, length: 2 };
  const digits = kind === 'u' ? 4 : kind === 'U' ? 8 : 0;
  const hex = source.slice(2, 2 + digits);
  if (digits > 0 && new RegExp(`^[0-9A-Fa-f]{${String(digits)}}$`, 'u').test(hex)) {
    const code = Number.parseInt(hex, 16);
    if (code <= 0x10ffff) return { text: String.fromCodePoint(code), length: 2 + digits };
  }
  // an escape TOML does not define makes the file invalid anyway; keep the character
  return { text: kind, length: 2 };
}

/**
 * The key and table paths a TOML text defines, as far as a conflict can matter: bare and
 * quoted keys, dotted keys, `[table]` and `[[array]]` headers, comments and multi-line
 * strings skipped. Not a full parser: it reads what `ror` must not collide with.
 */
export function tomlPaths(text: string): { path: string[]; table: boolean; offset: number }[] {
  const found: { path: string[]; table: boolean; offset: number }[] = [];
  let offset = 0;
  let current: string[] = [];
  let value: ValueState = { multiline: undefined, depth: 0 };
  const readKey = (source: string): { path: string[]; rest: string } | undefined => {
    const path: string[] = [];
    let rest = source.trimStart();
    for (;;) {
      const quote = rest[0];
      if (quote === '"' || quote === "'") {
        let end = 1;
        let value = '';
        while (end < rest.length && rest[end] !== quote) {
          if (quote === '"' && rest[end] === '\\') {
            const escaped = decodeEscape(rest.slice(end));
            value += escaped.text;
            end += escaped.length;
          } else {
            value += rest[end] ?? '';
            end += 1;
          }
        }
        if (end >= rest.length) return undefined;
        path.push(value);
        rest = rest.slice(end + 1).trimStart();
      } else {
        const bare = /^[A-Za-z0-9_-]+/u.exec(rest);
        if (bare === null) return undefined;
        path.push(bare[0]);
        rest = rest.slice(bare[0].length).trimStart();
      }
      if (rest[0] === '.') rest = rest.slice(1).trimStart();
      else return { path, rest };
    }
  };
  for (const line of text.split('\n')) {
    const lineOffset = offset;
    offset += line.length + 1;
    // a value that goes on (an open string, array or inline table) is not read as keys or headers
    if (value.multiline !== undefined || value.depth > 0) {
      value = scanStrings(line, value);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      const array = trimmed.startsWith('[[');
      const key = readKey(trimmed.slice(array ? 2 : 1));
      if (key !== undefined) {
        current = key.path;
        found.push({ path: key.path, table: true, offset: lineOffset });
      }
      continue;
    }
    const key = readKey(trimmed);
    if (key === undefined || key.rest[0] !== '=') continue;
    found.push({ path: [...current, ...key.path], table: false, offset: lineOffset });
    // a multi-line string may start anywhere in the value: in an array, in an inline table
    value = scanStrings(key.rest.slice(1), { multiline: undefined, depth: 0 });
  }
  return found;
}

type Multiline = '"""' | "'''";

/**
 * Walks one line the way TOML reads strings and says whether a multi-line string is still open at its end:
 * escapes in basic strings, a comment ending the line, `"""` and `'''` as delimiters.
 */
interface ValueState {
  readonly multiline: Multiline | undefined;
  /** Brackets and braces still open: the value goes on over the next lines. */
  readonly depth: number;
}

function scanStrings(line: string, from: ValueState): ValueState {
  let state = from.multiline;
  let depth = from.depth;
  let index = 0;
  while (index < line.length) {
    if (state === '"""') {
      if (line[index] === '\\') index += 2;
      else if (line.startsWith('"""', index)) {
        state = undefined;
        index += 3;
        // up to two more quotes may end the string's own text
        while (line[index] === '"') index += 1;
      } else index += 1;
    } else if (state === "'''") {
      if (line.startsWith("'''", index)) {
        state = undefined;
        index += 3;
        while (line[index] === "'") index += 1;
      } else index += 1;
    } else if (line[index] === '#') break;
    else if (line.startsWith('"""', index)) {
      state = '"""';
      index += 3;
    } else if (line.startsWith("'''", index)) {
      state = "'''";
      index += 3;
    } else if (line[index] === '"') {
      index += 1;
      while (index < line.length && line[index] !== '"') index += line[index] === '\\' ? 2 : 1;
      index += 1;
    } else if (line[index] === "'") {
      index += 1;
      while (index < line.length && line[index] !== "'") index += 1;
      index += 1;
    } else {
      if (line[index] === '[' || line[index] === '{') depth += 1;
      else if (line[index] === ']' || line[index] === '}') depth = Math.max(0, depth - 1);
      index += 1;
    }
  }
  return { multiline: state, depth };
}

const sameStart = (a: readonly string[], b: readonly string[]): boolean =>
  a.every((part, index) => b[index] === part);

/**
 * Whether the user's own TOML (outside our blocks) already defines what a block of top-level
 * dotted keys would define: the same key, a table that is one of its parents, or a value
 * standing where one of its parents must be a table. Any of these makes the file invalid.
 */
export function tomlConflict(outside: string, block: string): string | undefined {
  const theirs = tomlPaths(outside);
  for (const ours of tomlPaths(block)) {
    if (ours.table) continue;
    for (const other of theirs) {
      const same = other.path.length === ours.path.length && sameStart(other.path, ours.path);
      const parent = other.path.length < ours.path.length && sameStart(other.path, ours.path);
      // a user table `[permissions.ror.filesystem]` or a value `permissions = {..}` above ours
      if (same || parent) return ours.path.join('.');
    }
  }
  return undefined;
}
