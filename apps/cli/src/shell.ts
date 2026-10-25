/**
 * A conservative reading of a Bash command line, for `ror hook` (ADR-0085).
 *
 * It splits a line into simple commands (`;`, `&&`, `||`, `|`, `&`, newlines,
 * groups), removes quotes, reads `$( )` and backticks as commands of their own,
 * keeps redirection targets, and tracks `cd`. It does NOT run or expand
 * anything: variables, aliases, globs and the code inside `python -c` stay
 * opaque, which is why a command rule is reported `partial` and why the OS
 * sandbox stays the answer for what a program does by itself.
 */

import { isAbsolute } from 'node:path';

export interface Redirect {
  /** `>` and `>>` write the target; `<` reads it. */
  readonly access: 'read' | 'write';
  readonly target: string;
  /** `>>`: the target keeps what it had. */
  readonly append?: boolean;
  /** The descriptor when it is not stdout (`2>` is 2). */
  readonly fd?: number;
}

export interface SimpleCommand {
  /** The words, quotes removed. */
  readonly words: readonly string[];
  /** Redirection targets (`> file`, `< file`). */
  readonly redirects: readonly Redirect[];
  /** The directory the command runs in, after the `cd` that came before it on the line. */
  readonly cwd: string;
  /** Its stdin is the previous command's stdout (it follows a single `|`). */
  readonly piped?: boolean;
}

const MAX_DEPTH = 4;
const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')', '{', '}']);

/** The text of a `$( … )` that starts at `start` (just after the `(`), and where it ends. */
function substitution(source: string, start: number): { inner: string; end: number } {
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === '\\') index += 1;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    index += 1;
  }
  return { inner: source.slice(start, index - 1), end: index };
}

interface Lexed {
  readonly commands: string[][];
  readonly redirects: Redirect[][];
  readonly piped: boolean[];
  readonly nested: string[];
}

function lex(source: string): Lexed {
  const commands: string[][] = [];
  const redirects: Redirect[][] = [];
  const piped: boolean[] = [];
  let cmdPiped = false;
  let fdNext = 1;
  const nested: string[] = [];
  let words: string[] = [];
  let targets: Redirect[] = [];
  let word = '';
  let inWord = false;
  /** Set between a redirection operator and its target; 'skip' for a here-document's marker. */
  let redirectNext: 'read' | 'write' | 'skip' | undefined;
  let appendNext = false;
  let dupNext = false; // `>&2`: the word is a descriptor, not a file

  const endWord = (): void => {
    if (!inWord) return;
    if (redirectNext === undefined) words.push(word);
    // `>&2`, `2>&1`: a file descriptor, not a file
    else if (redirectNext !== 'skip' && !(dupNext && /^(?:\d+|-)$/u.test(word))) {
      targets.push({
        access: redirectNext,
        target: word,
        ...(appendNext && redirectNext === 'write' ? { append: true } : {}),
        ...(fdNext !== 1 ? { fd: fdNext } : {}),
      });
    }
    redirectNext = undefined;
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0 || targets.length > 0) {
      commands.push(words);
      redirects.push(targets);
      piped.push(cmdPiped);
    }
    cmdPiped = false;
    words = [];
    targets = [];
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (char === '\\' && next === '\n') {
      index += 2; // a line continuation: the shell removes both
    } else if (char === '\\') {
      word += next;
      inWord = true;
      index += 2;
    } else if (char === "'") {
      const close = source.indexOf("'", index + 1);
      const end = close < 0 ? source.length : close;
      word += source.slice(index + 1, end);
      inWord = true;
      index = end + 1;
    } else if (char === '"') {
      inWord = true;
      index += 1;
      while (index < source.length && source[index] !== '"') {
        const inner = source[index] ?? '';
        if (inner === '\\' && source[index + 1] === '\n') {
          index += 2;
        } else if (inner === '\\') {
          // in double quotes a backslash only escapes $ ` " \ ; before anything else it stays
          const escaped = source[index + 1] ?? '';
          word += '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`;
          index += 2;
        } else if (inner === '$' && source[index + 1] === '(') {
          const { inner: body, end } = substitution(source, index + 2);
          nested.push(body);
          index = end;
        } else if (inner === '`') {
          const close = source.indexOf('`', index + 1);
          const end = close < 0 ? source.length : close;
          nested.push(source.slice(index + 1, end));
          index = end + 1;
        } else {
          word += inner;
          index += 1;
        }
      }
      index += 1;
    } else if (char === '$' && next === '(') {
      const { inner, end } = substitution(source, index + 2);
      nested.push(inner);
      inWord = true;
      index = end;
    } else if (char === '`') {
      const close = source.indexOf('`', index + 1);
      const end = close < 0 ? source.length : close;
      nested.push(source.slice(index + 1, end));
      inWord = true;
      index = end + 1;
    } else if (char === '>' || char === '<') {
      // `2>`, `>>`, `<<EOF`, `&>`: the operator is no word, the next word is its target
      fdNext = 1;
      if (/^\d+$/u.test(word)) {
        fdNext = Number(word);
        word = '';
        inWord = false;
      } else endWord();
      index += 1;
      let doubled = 0;
      dupNext = false;
      while (source[index] === char || source[index] === '&') {
        doubled += source[index] === char ? 1 : 0;
        if (source[index] === '&') dupNext = true;
        index += 1;
      }
      // `<<` and `<<<` take a marker or a string, not a file
      redirectNext = char === '>' ? 'write' : doubled > 0 ? 'skip' : 'read';
      appendNext = char === '>' && doubled > 0;
    } else if (SEPARATORS.has(char)) {
      const pipe = char === '|' && next !== '|' && source[index - 1] !== '|';
      endCommand();
      cmdPiped = pipe;
      index += 1;
    } else if (char === ' ' || char === '\t') {
      endWord();
      index += 1;
    } else if (char === '#' && !inWord) {
      const close = source.indexOf('\n', index);
      index = close < 0 ? source.length : close;
    } else {
      word += char;
      inWord = true;
      index += 1;
    }
  }
  endCommand();
  return { commands, redirects, piped, nested };
}

/** Programs whose arguments can be a command line of their own. */
const SHELL_RUNNERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'eval',
  'ssh',
  'su',
  'script',
]);

function runsShellText(words: readonly string[]): boolean {
  return words.slice(0, 6).some((word) => SHELL_RUNNERS.has(word.split('/').at(-1) ?? ''));
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Every simple command of a line, nested ones included, each with the directory it runs in. */
export function parseShell(source: string, cwd: string, depth = 0): SimpleCommand[] {
  if (depth > MAX_DEPTH) return [];
  const { commands, redirects, piped, nested } = lex(source);
  const result: SimpleCommand[] = [];
  let here = cwd;
  commands.forEach((all, position) => {
    let start = 0;
    while (start < all.length && ASSIGNMENT.test(all[start] ?? '')) start += 1;
    const stripped = all.slice(start);
    const targets = redirects[position] ?? [];
    result.push({
      words: stripped,
      redirects: targets,
      cwd: here,
      ...(piped[position] === true ? { piped: true } : {}),
    });
    if ((stripped[0] === 'cd' || stripped[0] === 'pushd') && stripped[1] !== undefined) {
      here = isAbsolute(stripped[1]) ? stripped[1] : `${here}/${stripped[1]}`;
    }
    // `sh -c 'git push -f'`, `ssh host "…"`: a word that is itself a command line.
    // Only for a command that runs one: `echo "git push -f"` prints text.
    if (runsShellText(stripped)) {
      for (const word of stripped) {
        if (/\s/u.test(word)) result.push(...parseShell(word, here, depth + 1));
      }
    }
  });
  for (const inner of nested) result.push(...parseShell(inner, here, depth + 1));
  return result;
}

// ------------------------------------------------------------- PowerShell

/**
 * Forms of PowerShell this reader refuses to interpret (ADR-0086): a subexpression,
 * a script block, a call operator on a value, a type or method call, an encoded or
 * evaluated string, a backtick escape, a here-string. A command line that holds one
 * is refused whole when a rule could depend on it, never guessed.
 */
const POWERSHELL_CD = new Set([
  'cd',
  'chdir',
  'set-location',
  'sl',
  'pushd',
  'push-location',
  'popd',
  'pop-location',
]);
/** These need a stack of directories this reader does not keep. */
const POWERSHELL_STACK = new Set(['popd', 'pop-location']);

const POWERSHELL_OPAQUE =
  /\$\(|@\(|@\{|\{|\}|`|\[[A-Za-z][\w.]*\]|::|-enc(?:odedcommand)?\b|\biex\b|invoke-expression|invoke-command|start-process|\bicm\b|@['"]|^\s*&|[;|&]\s*&/iu;

/**
 * The simple commands of a PowerShell line, or undefined when it holds a form this
 * reader does not interpret. Separators are `;` `|` `&&` `||` and newlines; quotes
 * group words; `>` `>>` `<` name a file. Variables and aliases stay opaque, as in `parseShell`.
 */
export function parsePowerShell(source: string, cwd: string): SimpleCommand[] | undefined {
  if (POWERSHELL_OPAQUE.test(source)) return undefined;
  const result: SimpleCommand[] = [];
  let words: string[] = [];
  let targets: Redirect[] = [];
  let word = '';
  let inWord = false;
  let redirectNext: 'read' | 'write' | undefined;
  let appendNext = false;
  const endWord = (): void => {
    if (!inWord) return;
    if (redirectNext === undefined) words.push(word);
    else
      targets.push({
        access: redirectNext,
        target: word,
        ...(appendNext && redirectNext === 'write' ? { append: true } : {}),
      });
    redirectNext = undefined;
    word = '';
    inWord = false;
  };
  let here = cwd;
  const place = { unreadable: false };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0 || targets.length > 0) {
      result.push({ words, redirects: targets, cwd: here });
      const verb = (words[0] ?? '').toLowerCase();
      if (POWERSHELL_CD.has(verb)) {
        const where = words[1];
        // a directory this reader cannot place leaves every later command unplaceable
        if (
          where === undefined ||
          where.startsWith('-') ||
          /[$%]/u.test(where) ||
          POWERSHELL_STACK.has(verb)
        ) {
          place.unreadable = true;
        } else here = isAbsolute(where) ? where : `${here}/${where}`;
      }
    }
    words = [];
    targets = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (char === "'" || char === '"') {
      const close = source.indexOf(char, index + 1);
      if (close < 0) return undefined;
      word += source.slice(index + 1, close);
      inWord = true;
      index = close;
    } else if (char === '>' || char === '<') {
      endWord();
      appendNext = source[index + 1] === char;
      while (source[index + 1] === char) index += 1;
      redirectNext = char === '>' ? 'write' : 'read';
    } else if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '\r') {
      endCommand();
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return place.unreadable ? undefined : result;
}
