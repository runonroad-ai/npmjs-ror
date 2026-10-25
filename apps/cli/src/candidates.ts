/**
 * What a write tool is about to leave in a file, rebuilt before it happens (ADR-0088): the whole
 * new content for a Write, the file as it will be after an Edit, a MultiEdit or an apply_patch.
 * A change that cannot be rebuilt (the text to replace is not there, a patch does not apply) is
 * `undefined`: the tool would fail by itself, and a content rule never waves through what it
 * could not read.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import type { ToolCall } from './evaluate.js';
import { parsePowerShell, parseShell, type SimpleCommand } from './shell.js';

export interface Candidate {
  readonly path: string;
  readonly content: string;
}

const fileOf = (input: Readonly<Record<string, unknown>>): string | undefined => {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
};

const read = (path: string, cwd: string): string | undefined => {
  try {
    return readFileSync(isAbsolute(path) ? path : `${cwd}/${path}`, 'utf8');
  } catch {
    return undefined;
  }
};

/** One exact replacement the way the tools do it: unique unless `replace_all`. */
function replaceOnce(
  text: string,
  oldText: string,
  newText: string,
  all: boolean,
): string | undefined {
  if (oldText === '') return undefined;
  const first = text.indexOf(oldText);
  if (first < 0) return undefined;
  if (all) return text.split(oldText).join(newText);
  return text.indexOf(oldText, first + 1) >= 0
    ? undefined
    : text.slice(0, first) + newText + text.slice(first + oldText.length);
}

/** A hunk of an apply_patch: the lines it expects and the lines it leaves. */
function applyHunks(original: string, body: readonly string[]): string | undefined {
  let text = original;
  let hunk: { old: string[]; next: string[] } | undefined;
  const hunks: { old: string[]; next: string[] }[] = [];
  for (const line of body) {
    if (line.startsWith('@@')) {
      hunk = { old: [], next: [] };
      hunks.push(hunk);
    } else if (line === '*** End of File') continue;
    else {
      hunk ??= (hunks.push({ old: [], next: [] }), hunks[hunks.length - 1]);
      if (hunk === undefined) return undefined;
      const mark = line[0];
      const rest = line.slice(1);
      if (mark === '+') hunk.next.push(rest);
      else if (mark === '-') hunk.old.push(rest);
      else {
        hunk.old.push(rest);
        hunk.next.push(rest);
      }
    }
  }
  for (const each of hunks) {
    const replaced = replaceOnce(text, each.old.join('\n'), each.next.join('\n'), false);
    if (replaced === undefined) return undefined;
    text = replaced;
  }
  return text;
}

function patchCandidates(patch: string, cwd: string): Candidate[] | undefined {
  const lines = patch.replace(/\r\n?/gu, '\n').split('\n');
  const out: Candidate[] = [];
  let index = 1;
  while (index < lines.length) {
    const header = /^\*\*\* (Add File|Update File|Delete File): (.+)$/u.exec(lines[index] ?? '');
    if (header === null) {
      index += 1;
      continue;
    }
    const path = (header[2] ?? '').trim();
    index += 1;
    // a rename comes right after the header, before the hunks that change the file
    const moved = /^\*\*\* Move to: (.+)$/u.exec(lines[index] ?? '');
    if (moved !== null) index += 1;
    const body: string[] = [];
    while (index < lines.length && !(lines[index] ?? '').startsWith('*** ')) {
      body.push(lines[index] ?? '');
      index += 1;
    }
    if (header[1] === 'Add File') {
      out.push({ path, content: body.map((line) => line.slice(1)).join('\n') });
    } else if (header[1] === 'Update File') {
      const original = read(path, cwd);
      const rebuilt = original === undefined ? undefined : applyHunks(original, body);
      if (rebuilt === undefined) return undefined;
      out.push({ path: moved?.[1]?.trim() ?? path, content: rebuilt });
    }
  }
  return out;
}

/** The candidates of a write tool call; an empty list for a tool that writes nothing. */
export function candidatesOf(call: ToolCall): Candidate[] | undefined {
  const { tool_name: tool, tool_input: input, cwd } = call;
  const path = fileOf(input);
  if (tool === 'Write') {
    const content = input['content'];
    return path !== undefined && typeof content === 'string' ? [{ path, content }] : undefined;
  }
  if (tool === 'NotebookEdit') {
    const source = input['new_source'];
    return path !== undefined && typeof source === 'string' ? [{ path, content: source }] : [];
  }
  if (tool === 'Edit') {
    const original = path === undefined ? undefined : read(path, cwd);
    const oldText = input['old_string'];
    const newText = input['new_string'];
    if (path === undefined || original === undefined) return undefined;
    if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined;
    const rebuilt = replaceOnce(original, oldText, newText, input['replace_all'] === true);
    return rebuilt === undefined ? undefined : [{ path, content: rebuilt }];
  }
  if (tool === 'MultiEdit') {
    const edits = input['edits'];
    const original = path === undefined ? undefined : read(path, cwd);
    if (path === undefined || original === undefined || !Array.isArray(edits)) return undefined;
    let text: string = original;
    for (const edit of edits as Record<string, unknown>[]) {
      const oldText = edit['old_string'];
      const newText = edit['new_string'];
      if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined;
      const next: string | undefined = replaceOnce(
        text,
        oldText,
        newText,
        edit['replace_all'] === true,
      );
      if (next === undefined) return undefined;
      text = next;
    }
    return [{ path, content: text }];
  }
  if (tool === 'apply_patch') {
    const patch = input['command'] ?? input['patch'] ?? input['input'];
    return typeof patch === 'string' ? patchCandidates(patch, cwd) : undefined;
  }
  return [];
}

// ------------------------------------------------------------------- shell

/** Programs that leave their input in a file; with a `>` redirection, any program does. */
const SHELL_WRITERS = new Set(['tee', 'cp', 'mv', 'install', 'rsync', 'dd']);
const POWERSHELL_WRITERS = new Set([
  'set-content',
  'add-content',
  'out-file',
  'copy-item',
  'move-item',
  'new-item',
]);
/** Programs whose words are patterns, options or file names: what they write comes from the files, not their arguments. */
const NOT_CONTENT = new Set([
  'cat',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
  'find',
  'ls',
  'head',
  'tail',
  'wc',
  'diff',
  'git',
  'cp',
  'mv',
  'install',
  'rsync',
  'tee',
  'dd',
  'cd',
  'test',
  'sort',
  'uniq',
  'cut',
  'tr',
]);
const MAX_FILE_BYTES = 1024 * 1024;

const writesFiles = (simple: SimpleCommand): boolean => {
  const program = (simple.words[0] ?? '').split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
  return (
    simple.redirects.some((redirect) => redirect.access === 'write') ||
    SHELL_WRITERS.has(program) ||
    POWERSHELL_WRITERS.has(program) ||
    (program === 'sed' && simple.words.some((word) => /^-[A-Za-z]*i|^--in-place/u.test(word)))
  );
};

/**
 * What a shell command that writes a file would put there, as far as it can be read: the command
 * itself (an `echo "..." > f`, a here-document) and the files it names (`cp a b`, `cat a > b`).
 * Nothing is run. A command that writes nothing yields no text; a script that makes its content
 * out of sight is outside this (the founder-Lead scoped it out), but the plain copy is inside.
 */
export function shellCandidates(call: ToolCall): { texts: string[]; unreadable: boolean } {
  const command = call.tool_input['command'];
  if (typeof command !== 'string') return { texts: [], unreadable: false };
  const simples =
    call.shell === 'powershell'
      ? parsePowerShell(command, call.cwd)
      : parseShell(command, call.cwd);
  if (simples === undefined || !simples.some(writesFiles)) return { texts: [], unreadable: false };
  // the words as the shell will pass them, quotes removed: a quote around an echo is syntax, not somebody's words
  // a printf prints its format filled with the arguments, not every argument it was given
  const programOf = (simple: SimpleCommand): string =>
    (simple.words[0] ?? '').split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
  const asWritten = (simple: SimpleCommand): string =>
    (simple.words[0] ?? '').split(/[\\/]/u).at(-1) === 'printf'
      ? (printfOutput(simple.words.slice(1)) ?? simple.words.join(' '))
      : simple.words.join(' ');
  // what echo or printf print without writing a file stays on the terminal; here-document lines are no command
  const texts = [
    simples
      .filter(
        (simple) =>
          !NOT_CONTENT.has(programOf(simple)) &&
          (writesFiles(simple) || !['echo', 'printf'].includes(programOf(simple))),
      )
      .map(asWritten)
      .join('\n'),
  ];
  let unreadable = false;
  const virtual = new Map<string, string>();
  let previous: string | undefined; // what the command before this one printed: a pipe hands it to `tee` or a bare `cat`
  for (const [position, simple] of simples.entries()) {
    // output that stays on the terminal is not refused for being unreadable
    const reachesFile =
      simple.redirects.some((r) => r.access === 'write' && r.fd === undefined) ||
      simples[position + 1]?.piped === true;
    const inPlace = rewriteOf(simple);
    // a command that only reads shows its files on the terminal: their content is not written anywhere
    const writes = writesFiles(simple);
    const overwritten = new Set(
      simple.redirects.filter((r) => r.access === 'write' && !r.append).map((r) => r.target),
    );
    // what each file holds after this command, so a later `>>` sees the earlier writes of the same line
    const program = (simple.words[0] ?? '').split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
    // echo ends its line, printf does not: a later append starts on a new line only after echo
    const refuse = (): string => {
      if (reachesFile) unreadable = true;
      return '';
    };
    const printed = program === 'printf' ? printfOutput(simple.words.slice(1)) : undefined;
    // a format this reader cannot evaluate is refused, not guessed
    if (program === 'printf' && printed === undefined && reachesFile) unreadable = true;
    const text =
      printed ??
      (program === 'echo'
        ? (echoOutput(simple.words.slice(1)) ?? refuse())
        : simple.words.slice(1).join(' '));
    const plain = simple.words.slice(1).filter((w) => !w.startsWith('-'));
    // `cp a b`: b is replaced, its old text is not what the command writes
    const replaced =
      ['cp', 'mv', 'install'].includes(program) && plain.length > 1 ? plain.at(-1) : undefined;
    // stdin comes from the pipe only when this command follows a `|` and reads no file by `<`
    const fromFile = simple.redirects.find((r) => r.access === 'read');
    const stdin =
      fromFile !== undefined
        ? (virtual.get(resolve(simple.cwd, fromFile.target)) ?? read(fromFile.target, simple.cwd))
        : simple.piped === true
          ? previous
          : undefined;
    const copies: string[] = [];
    for (const word of [
      ...simple.words.slice(1),
      // `cat - < a` reads a once, through the dash
      ...(program === 'cat' && simple.words.includes('-')
        ? []
        : simple.redirects.filter((r) => r.access === 'read').map((r) => r.target)),
    ]) {
      // `cat - `: the dash is stdin, in operand order
      if (program === 'cat' && word === '-' && stdin !== undefined) {
        copies.push(stdin);
        if (writes) texts.push(stdin);
        continue;
      }
      const copied =
        ['echo', 'printf', 'tee'].includes(program) ||
        word.startsWith('-') ||
        inPlace !== undefined ||
        word === replaced
          ? undefined
          : word === '/dev/null'
            ? ''
            : // the shell empties a file it redirects into before any command reads it
              overwritten.has(word)
              ? ''
              : (virtual.get(resolve(simple.cwd, word)) ?? read(word, simple.cwd));
      if (copied !== undefined) {
        copies.push(copied);
        if (writes) texts.push(copied);
      }
    }
    // `cat a b`: the files side by side, as the shell concatenates them
    const joined = copies.length > 1 ? copies.join('') : undefined;
    if (joined !== undefined && writes) texts.push(joined);
    // `cp a b`, `mv a b`: b now holds a, so a later `>>` onto b is judged with it
    const operands = simple.words.slice(1).filter((word) => !word.startsWith('-'));
    if (['cp', 'mv', 'install'].includes(program) && operands.length === 2 && copies.length >= 1) {
      const target = resolve(simple.cwd, operands[1] ?? '');
      let into = target;
      try {
        // a directory receives the file under its own name
        if (statSync(target).isDirectory()) into = join(target, basename(operands[0] ?? ''));
      } catch {
        // not there yet: the destination is the name itself
      }
      virtual.set(into, copies[0] ?? '');
      // a moved file is no longer where it was
      if (program === 'mv') virtual.set(resolve(simple.cwd, operands[0] ?? ''), '');
    }
    const teed = program === 'tee' && stdin !== undefined;
    const outs = teed
      ? [
          ...simple.redirects.filter((r) => r.access === 'write' && r.fd === undefined),
          ...plain.map((target) => ({
            access: 'write' as const,
            target,
            append: simple.words.some((w) => w === '--append' || /^-[A-Za-z]*a[A-Za-z]*$/u.test(w)),
          })),
        ]
      : simple.redirects.filter((r) => r.fd === undefined);
    const fedByPipe =
      (teed || (program === 'cat' && plain.length === 0 && copies.length === 0)) &&
      stdin !== undefined;
    // only the last stdout redirection of a command receives its output
    const lastOut = outs.filter((r) => r.access === 'write').at(-1);
    for (const r of outs) {
      if (r.access !== 'write') continue;
      if (!teed && r !== lastOut) {
        // an earlier destination is still opened, so `>` empties it
        if (r.append !== true) virtual.set(resolve(simple.cwd, r.target), '');
        continue;
      }
      const added = fedByPipe
        ? [stdin]
        : [
            ...(NOT_CONTENT.has(program) ? [] : [text]),
            ...(joined !== undefined ? [joined] : copies.length === 1 ? copies : []),
          ];
      const old =
        'append' in r && r.append
          ? (virtual.get(resolve(simple.cwd, r.target)) ?? read(r.target, simple.cwd) ?? '')
          : '';
      for (const piece of added) texts.push(`${old}${piece}`);
      virtual.set(resolve(simple.cwd, r.target), `${old}${added.at(-1) ?? ''}`);
    }
    // cat and tee pass their input on, so a longer pipeline still carries the text
    if (program === 'echo' || program === 'printf') {
      // stdout sent to a file leaves nothing for the next command in the pipe
      previous = simple.redirects.some((r) => r.access === 'write' && r.fd === undefined)
        ? ''
        : text;
    } else if (program === 'cat' && copies.length > 0) previous = copies.join('');
    else if (!['cat', 'tee'].includes(program)) previous = undefined;
    if (program === 'tee' && stdin !== undefined) previous = stdin;
    // cat and tee hand on what they read; a redirected stdout hands on nothing
    if (
      ['cat', 'tee'].includes(program) &&
      simple.redirects.some((r) => r.access === 'write' && r.fd === undefined)
    ) {
      previous = '';
    }
    // what echo, printf and tee print is their text; their operands are not files being read
    const printsText = ['echo', 'printf', 'tee'].includes(program);
    for (const word of [
      ...(printsText ? [] : simple.words.slice(1)),
      ...simple.redirects.map((r) => r.target),
    ]) {
      // the old text of a file this command overwrites is not what it writes
      if (word.startsWith('-') || word === '' || overwritten.has(word)) continue;
      if (word === replaced || !writes) continue;
      const full = isAbsolute(word) ? word : `${simple.cwd}/${word}`;
      let size: number;
      try {
        size = statSync(full).size;
      } catch {
        continue; // not a file that exists: a destination, an option value
      }
      if (!statSync(full).isFile()) {
        // a directory copied or moved carries files this reader does not walk: refused, not waved through
        if (statSync(full).isDirectory() && ['cp', 'mv', 'rsync', 'install'].includes(program)) {
          unreadable = true;
        }
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        unreadable = true; // an ordinary copy of a file too large to read is never waved through
        continue;
      }
      const body = read(word, simple.cwd);
      if (body === undefined) continue;
      if (inPlace !== undefined) {
        const rewritten = inPlace(body);
        if (rewritten === undefined) unreadable = true;
        else texts.push(rewritten);
      } else texts.push(body);
    }
  }
  return { texts, unreadable };
}

/** What `echo` prints: option words (-n -e -E) are not output, and -n drops the final newline. */
function echoOutput(words: readonly string[]): string | undefined {
  let rest = words;
  let newline = true;
  let escapes = false;
  while (rest[0] !== undefined && /^-[neE]+$/u.test(rest[0])) {
    if (rest[0].includes('n')) newline = false;
    if (rest[0].includes('e')) escapes = true;
    rest = rest.slice(1);
  }
  // -e decodes \\x64 and the like: what it would write cannot be read here, so it is refused
  if (escapes && rest.some((word) => word.includes('\\'))) return undefined;
  return `${rest.join(' ')}${newline ? '\n' : ''}`;
}

/** `%d` reads its argument as C does: 010 is octal, 0x1f hex; `%s` copies it. */
function conversion(token: string, argument: string | undefined): string {
  // a missing argument prints nothing for %s and 0 for %d
  if (token !== '%d') return argument ?? '';
  if (argument === undefined) return '0';
  // a leading quote means the character's code: printf %d "'A" is 65
  if (/^['"]./u.test(argument)) return String(argument.codePointAt(1));
  const n = /^[-+]?0[0-7]*$/u.test(argument)
    ? Number.parseInt(argument, 8)
    : /^[-+]?0[xX][\da-fA-F]+$/u.test(argument)
      ? Number.parseInt(argument, 16)
      : /^[-+]?\d+$/u.test(argument)
        ? Number.parseInt(argument, 10)
        : Number.NaN;
  // a leading zero with an 8 or a 9 is a broken octal: bash keeps the octal digits it read
  if (/^[-+]?0\d*[89]/u.test(argument)) {
    return String(Number.parseInt(/^[-+]?0[0-7]*/u.exec(argument)?.[0] ?? '0', 8));
  }
  if (!Number.isNaN(n)) return String(n);
  // bash prints the number it could read at the start of the argument (and complains)
  const hex = /^[-+]?0[xX][\da-fA-F]+/u.exec(argument)?.[0];
  if (hex !== undefined) return String(Number.parseInt(hex, 16));
  const prefix = /^[-+]?\d+/u.exec(argument)?.[0];
  return prefix === undefined ? '0' : String(Number.parseInt(prefix, 10));
}

/** What `printf FORMAT ARGS` prints for the formats that can be read (%s %d %% and escapes); undefined otherwise. */
function printfOutput(given: readonly string[]): string | undefined {
  const words = given[0] === '--' ? given.slice(1) : given;
  const format = words[0] ?? '';
  if (!/^(?:[^%\\]|\\[nt\\]|%%|%s|%d)*$/u.test(format)) return undefined;
  const escaped = (text: string): string =>
    text.replace(/\\([nt\\])/gu, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));
  const slots = (format.replaceAll('%%', '').match(/%[sd]/gu) ?? []).length;
  const args = words.slice(1);
  if (slots === 0) return escaped(format.replaceAll('%%', '%'));
  let out = '';
  let used = 0;
  do {
    // the escapes belong to the format's own text; an argument is copied as it is
    out += format
      .split(/(%%|%[sd])/u)
      .map((part) =>
        part === '%%'
          ? '%'
          : part === '%s' || part === '%d'
            ? conversion(part, args[used++])
            : escaped(part),
      )
      .join('');
  } while (used < args.length);
  return out;
}

/**
 * `sed -i 's/old/new/[gI]' file` with nothing else: the file after the substitution, line by line as
 * sed does it (the first match of each line, every match with `g`), so the RESULT is judged. Any
 * other form (several expressions, `-e`, `-E`, `&` or a backslash in the replacement, a backslash in
 * the pattern) cannot be reconstructed with sed's own semantics and is refused, not guessed.
 */
function rewriteOf(simple: SimpleCommand): ((text: string) => string | undefined) | undefined {
  const program = (simple.words[0] ?? '').split(/[\\/]/u).at(-1) ?? '';
  const flags = simple.words.slice(1).filter((word) => word.startsWith('-'));
  if (program !== 'sed' || !flags.some((word) => /^-[A-Za-z]*i|^--in-place/u.test(word))) {
    return undefined;
  }
  const scripts = simple.words.slice(1).filter((word) => /^s(.).*\1.*\1[gI]*$/u.test(word));
  const simpleFlags = flags.every((word) => /^(?:-i|--in-place|-i\.?[\w]*)$/u.test(word));
  const script = scripts.length === 1 && simpleFlags ? scripts[0] : undefined;
  return (text) => {
    if (script === undefined) return undefined;
    const delimiter = script[1] ?? '/';
    const parts = script.slice(2).split(delimiter);
    if (parts.length !== 3) return undefined;
    const [pattern = '', replacement = '', modifiers = ''] = parts;
    if (pattern.includes('\\') || replacement.includes('\\') || replacement.includes('&')) {
      return undefined;
    }
    try {
      // in a basic regular expression + ? | ( ) { } are plain characters
      const expression = new RegExp(
        pattern.replace(/[+?|(){}]/gu, '\\$&'),
        modifiers.includes('I') ? 'iu' : 'u',
      );
      const global = modifiers.includes('g');
      return text
        .split('\n')
        .map((line) =>
          global
            ? line.replace(new RegExp(expression.source, `${expression.flags}g`), () => replacement)
            : line.replace(expression, () => replacement),
        )
        .join('\n');
    } catch {
      return undefined;
    }
  };
}
