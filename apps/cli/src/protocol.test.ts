/**
 * What each tool says to a hook and expects back (ADR-0086): one test per
 * spelling, because a mistake here is a tool call that is not judged at all.
 */
import { describe, expect, it } from 'vitest';

import { allowOutput, denyOutput, parseRequest } from './protocol.js';

const json = (value: unknown): string => JSON.stringify(value);

describe('parseRequest', () => {
  it('reads Claude Code and Codex the same way, apply_patch included', () => {
    const bash = json({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/p' });
    expect(parseRequest(bash, 'claude_code', undefined, '.')).toEqual({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/p',
    });
    const patch = json({
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** End Patch' },
      cwd: '/p',
    });
    expect(parseRequest(patch, 'codex', undefined, '.')?.tool_name).toBe('apply_patch');
  });

  it('reads Cursor by event: shell, file read, MCP and the generic tool event', () => {
    expect(
      parseRequest(json({ command: 'git push', cwd: '/p' }), 'cursor', 'beforeShellExecution', '.'),
    ).toEqual({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: '/p' });
    expect(
      parseRequest(json({ file_path: '/p/vault/a' }), 'cursor', 'beforeReadFile', '/p')?.tool_name,
    ).toBe('Read');
    expect(
      parseRequest(json({ server: 'db', tool_name: 'query' }), 'cursor', 'beforeMCPExecution', '/p')
        ?.tool_name,
    ).toBe('mcp__db__query');
    expect(
      parseRequest(json({ tool_name: 'Write', tool_input: {} }), 'cursor', 'preToolUse', '/p')
        ?.tool_name,
    ).toBe('Write');
  });

  it('refuses what it cannot read, instead of guessing', () => {
    expect(parseRequest('not json', 'codex', undefined, '.')).toBeUndefined();
    expect(parseRequest(json({}), 'claude_code', undefined, '.')).toBeUndefined();
    expect(parseRequest(json({ command: 'x' }), 'cursor', undefined, '.')).toBeUndefined();
    expect(parseRequest(json({ command: 'x' }), 'cursor', 'afterFileEdit', '.')).toBeUndefined();
    expect(
      parseRequest(json({ server: 'db' }), 'cursor', 'beforeMCPExecution', '.'),
    ).toBeUndefined();
  });
});

describe('answers', () => {
  it('Claude Code and Codex read a JSON deny and an empty allow', () => {
    for (const target of ['claude_code', 'codex'] as const) {
      expect(allowOutput(target)).toEqual({ stdout: '', exitCode: 0 });
      const denied = denyOutput(target, 'no');
      expect(denied.exitCode).toBe(0);
      expect(JSON.parse(denied.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'no',
        },
      });
    }
  });

  it('Cursor reads its own JSON and exit code 2', () => {
    expect(JSON.parse(allowOutput('cursor').stdout)).toEqual({ permission: 'allow' });
    const denied = denyOutput('cursor', 'no');
    expect(denied.exitCode).toBe(2);
    expect(JSON.parse(denied.stdout)).toMatchObject({ permission: 'deny', user_message: 'no' });
  });
});
