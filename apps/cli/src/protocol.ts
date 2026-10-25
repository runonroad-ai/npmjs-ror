/**
 * What each AI tool says to a hook and expects back (ADR-0086). The evaluator
 * speaks one vocabulary (`ToolCall`); this file is the only place that knows how
 * Claude Code, Codex and Cursor spell a tool call and a refusal. A new tool is a
 * new case here, a native-artifact generator and a capability probe.
 *
 * No imports but types: it runs on every tool call.
 */
import type { ToolCall } from './evaluate.js';

export type HookTarget = 'claude_code' | 'codex' | 'cursor';

/** The hook events of Cursor ror registers, named as Cursor names them. */
export const CURSOR_EVENTS = [
  'beforeShellExecution',
  'beforeReadFile',
  'beforeMCPExecution',
  'preToolUse',
] as const;

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** The tool call a hook was started for, or undefined when it cannot be read (the caller then refuses). */
export function parseRequest(
  stdin: string,
  target: HookTarget,
  event: string | undefined,
  fallbackCwd: string,
): ToolCall | undefined {
  let input: Record<string, unknown> | undefined;
  try {
    input = object(JSON.parse(stdin));
  } catch {
    return undefined;
  }
  if (input === undefined) return undefined;
  const cwd = text(input['cwd']) ?? fallbackCwd;
  if (target !== 'cursor') {
    const name = text(input['tool_name']);
    if (name === undefined) return undefined;
    const sessionId = text(input['session_id']);
    const call: ToolCall = {
      tool_name: name,
      tool_input: object(input['tool_input']) ?? {},
      cwd,
      // the tool says which conversation and turn this is: an attestation is bound to them
      ...(sessionId === undefined
        ? {}
        : { session: { id: sessionId, turn: text(input['prompt_id']) ?? text(input['turn_id']) } }),
    };
    // Codex runs its shell tool through PowerShell on Windows
    return target === 'codex' && name === 'Bash' && process.platform === 'win32'
      ? { ...call, shell: 'powershell' }
      : call;
  }
  switch (event) {
    case 'beforeShellExecution': {
      const command = text(input['command']);
      return command === undefined
        ? undefined
        : { tool_name: 'Bash', tool_input: { command }, cwd: text(input['cwd']) ?? cwd };
    }
    case 'beforeReadFile': {
      const file = text(input['file_path']) ?? text(input['path']);
      return file === undefined
        ? undefined
        : { tool_name: 'Read', tool_input: { file_path: file }, cwd };
    }
    case 'beforeMCPExecution': {
      const server = text(input['server']) ?? text(input['server_name']);
      const tool = text(input['tool_name']) ?? text(input['tool']);
      return server === undefined || tool === undefined
        ? undefined
        : {
            tool_name: `mcp__${server}__${tool}`,
            tool_input: object(input['tool_input']) ?? {},
            cwd,
          };
    }
    case 'preToolUse': {
      const name = text(input['tool_name']);
      return name === undefined
        ? undefined
        : { tool_name: name, tool_input: object(input['tool_input']) ?? {}, cwd };
    }
    default:
      return undefined;
  }
}

export interface HookOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

/** An allow; `signal` is something the AI should look at before it goes on (ADR-0088). */
export function allowOutput(target: HookTarget, signal?: string): HookOutput {
  if (target === 'cursor') {
    return {
      stdout: JSON.stringify(
        signal === undefined
          ? { permission: 'allow' }
          : { permission: 'allow', agent_message: signal },
      ),
      exitCode: 0,
    };
  }
  return {
    stdout:
      signal === undefined
        ? ''
        : JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: signal },
          }),
    exitCode: 0,
  };
}

export type EventKind = 'tool' | 'prompt' | 'stop';

/** Which moment of the conversation a hook was started for. */
export function eventKind(stdin: string, target: HookTarget, event: string | undefined): EventKind {
  if (target === 'cursor') {
    return event === 'beforeSubmitPrompt' ? 'prompt' : event === 'stop' ? 'stop' : 'tool';
  }
  try {
    const name = object(JSON.parse(stdin))?.['hook_event_name'];
    return name === 'UserPromptSubmit' ? 'prompt' : name === 'Stop' ? 'stop' : 'tool';
  } catch {
    return 'tool';
  }
}

export interface ConversationInput {
  readonly cwd: string;
  readonly prompt: string | undefined;
  readonly lastAnswer: string | undefined;
  /** True while the tool is already carrying out a correction this hook asked for. */
  readonly continuing: boolean;
}

export function conversationInput(
  stdin: string,
  fallbackCwd: string,
): ConversationInput | undefined {
  let input: Record<string, unknown> | undefined;
  try {
    input = object(JSON.parse(stdin));
  } catch {
    return undefined;
  }
  if (input === undefined) return undefined;
  return {
    cwd: text(input['cwd']) ?? fallbackCwd,
    prompt: text(input['prompt']) ?? text(input['text']),
    lastAnswer: text(input['last_assistant_message']) ?? text(input['text']),
    continuing: input['stop_hook_active'] === true,
  };
}

/** The person's message stops here, with the reason shown to them. */
export function promptBlockOutput(target: HookTarget, reason: string): HookOutput {
  return {
    stdout: JSON.stringify(
      target === 'cursor'
        ? { continue: false, user_message: reason }
        : { decision: 'block', reason },
    ),
    exitCode: 0,
  };
}

/** Text put in front of the AI with the person's message. Cursor has no such door: it is dropped there. */
export function contextOutput(target: HookTarget, context: string): HookOutput {
  if (target === 'cursor') return { stdout: JSON.stringify({ continue: true }), exitCode: 0 };
  if (context === '') return { stdout: '', exitCode: 0 };
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
    }),
    exitCode: 0,
  };
}

/** The AI is made to go on and correct its answer. */
export function stopBlockOutput(target: HookTarget, reason: string): HookOutput {
  return {
    stdout: JSON.stringify(
      target === 'cursor' ? { followup_message: reason } : { decision: 'block', reason },
    ),
    exitCode: 0,
  };
}

/** Claude Code and Codex read the same JSON; Cursor reads its own and honours exit code 2. */
export function denyOutput(target: HookTarget, reason: string): HookOutput {
  if (target === 'cursor') {
    return {
      stdout: JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason }),
      exitCode: 2,
    };
  }
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}
