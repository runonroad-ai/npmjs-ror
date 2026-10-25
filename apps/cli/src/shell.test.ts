import { describe, expect, it } from 'vitest';

import { parseShell } from './shell.js';

const words = (source: string): string[][] => parseShell(source, '/p').map((c) => [...c.words]);

describe('parseShell', () => {
  it('splits a line into simple commands', () => {
    expect(words('a b; c && d || e | f & g\nh')).toEqual([
      ['a', 'b'],
      ['c'],
      ['d'],
      ['e'],
      ['f'],
      ['g'],
      ['h'],
    ]);
  });

  it('removes quotes and honours escapes', () => {
    const [first] = words(`git "push" 'x y' a\\ b`);
    expect(first).toEqual(['git', 'push', 'x y', 'a b']);
  });

  it('reads $( ) and backticks as commands of their own', () => {
    const commands = words('echo $(git push -f) `rm -rf x` "$(ls /a)"');
    expect(commands).toContainEqual(['git', 'push', '-f']);
    expect(commands).toContainEqual(['rm', '-rf', 'x']);
    expect(commands).toContainEqual(['ls', '/a']);
  });

  it('reads the command line inside a word, as sh -c and ssh need', () => {
    expect(words(`sh -c 'cd x && git push --force'`)).toContainEqual(['git', 'push', '--force']);
  });

  it('keeps redirection targets apart from the arguments', () => {
    const [cat] = parseShell('cat a > out.txt 2>> err.log < in.txt', '/p');
    expect(cat?.words).toEqual(['cat', 'a']);
    expect(cat?.redirects).toEqual([
      { access: 'write', target: 'out.txt' },
      { access: 'write', target: 'err.log', append: true, fd: 2 },
      { access: 'read', target: 'in.txt' },
    ]);
  });

  it('drops leading variable assignments and tracks cd', () => {
    const [first, second, third] = parseShell('FOO=1 BAR=2 git status; cd sub && ls; ls', '/p');
    expect(first?.words).toEqual(['git', 'status']);
    expect(second?.words).toEqual(['cd', 'sub']);
    expect(third?.cwd).toBe('/p/sub');
  });

  it('ignores comments and survives an unclosed quote', () => {
    expect(words('ls # git push -f')).toEqual([['ls']]);
    expect(() => parseShell(`echo "unclosed $(`, '/p')).not.toThrow();
  });

  it('stops going deeper than it should', () => {
    const nested = 'echo $(echo $(echo $(echo $(echo $(echo $(git push -f))))))';
    expect(() => parseShell(nested, '/p')).not.toThrow();
  });
});
