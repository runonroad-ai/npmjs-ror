import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  codeOfPolicyRefusal,
  mayTry,
  noteFailure,
  pendingBatch,
  recordIncident,
} from './health.js';

const folders: string[] = [];
const home = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'ror-health-'));
  folders.push(folder);
  return folder;
};
beforeEach(() => {
  // the machine lock lives under RUNONROAD_HOME: never the real one
  process.env['RUNONROAD_HOME'] = join(home(), '.runonroad');
});
afterEach(() => {
  delete process.env['RUNONROAD_HOME'];
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const incident = {
  target: 'claude_code',
  hook: 'stop',
  code: 'policy_expired',
  effect: 'failed_open',
} as const;

describe('hook health (ADR-0091)', () => {
  it('only appends closed lines: nothing but four words per incident', () => {
    const dir = home();
    recordIncident(dir, incident);
    recordIncident(dir, incident);
    const text = readFileSync(join(dir, 'ror-health.log'), 'utf8');
    expect(text).toBe(
      'claude_code stop policy_expired failed_open\nclaude_code stop policy_expired failed_open\n',
    );
  });

  it('never throws and never follows a link planted where the file goes', () => {
    const dir = home();
    const target = join(dir, 'victim.txt');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(dir, 'ror-health.log'));
    expect(() => {
      recordIncident(dir, incident);
    }).not.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('stops writing at the bound instead of growing', () => {
    const dir = home();
    writeFileSync(join(dir, 'ror-health.log'), 'x'.repeat(16 * 1024));
    recordIncident(dir, incident);
    expect(readFileSync(join(dir, 'ror-health.log'), 'utf8')).toHaveLength(16 * 1024);
  });

  it('survives a folder that cannot be written', () => {
    const dir = home();
    writeFileSync(join(dir, 'a-file'), '');
    expect(() => {
      recordIncident(join(dir, 'a-file', 'inside'), incident);
    }).not.toThrow();
  });

  it('turns a policy refusal into a closed code, never its text', () => {
    expect(codeOfPolicyRefusal('the policy has expired')).toBe('policy_expired');
    expect(codeOfPolicyRefusal('no policy file')).toBe('policy_missing');
    expect(codeOfPolicyRefusal('some path /home/x/secret.json failed')).toBe('signature_invalid');
  });
});

import { captureBatch, settleBatch } from './health.js';
import { apiClient } from './api.js';
import { reportHealth } from './health-report.js';

const clientOver = (fetch: typeof globalThis.fetch) =>
  apiClient({
    server: 'https://api.test',
    tokens: { get: () => 'tok', set: () => undefined, delete: () => false },
    fetch,
  });

describe('the batch ror sync sends (ADR-0091)', () => {
  it('sends the closed incidents once, keeps the batch until the server answers, never sends a count', async () => {
    const dir = home();
    recordIncident(dir, incident);
    recordIncident(dir, incident);
    const sent: { body: string }[] = [];
    const offline = (() => Promise.reject(new Error('down'))) as unknown as typeof fetch;
    const at = (hours: number) => ({ now: () => new Date(Date.UTC(2026, 9, 19, hours)) });
    await reportHealth({ client: clientOver(offline), ...at(10) }, dir);
    // still pending: the same batch is captured again
    const again = captureBatch(dir, () => 'unused-gen');
    expect(again?.sequence).toBe(1);
    const ok = (async (request: Request) => {
      sent.push({ body: await request.text() });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    // too soon after the failure: nothing is sent yet
    await reportHealth({ client: clientOver(ok), ...at(10) }, dir);
    expect(sent).toHaveLength(0);
    await reportHealth({ client: clientOver(ok), ...at(12) }, dir);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'generation',
      'incidents',
      'incomplete',
      'saturated',
      'sequence',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/count/u);
    // acknowledged: nothing left to send
    expect(captureBatch(dir, () => 'unused-gen')).toBeUndefined();
  });

  it('numbers the next batch after the acknowledged one, in the same generation', () => {
    const dir = home();
    recordIncident(dir, incident);
    const first = captureBatch(dir, () => 'gen-AAAAAAAA');
    if (first === undefined) throw new Error('expected a batch');
    settleBatch(dir, first);
    recordIncident(dir, { ...incident, code: 'internal_error' });
    const second = captureBatch(dir, () => 'gen-BBBBBBBB');
    expect(second?.generation).toBe('gen-AAAAAAAA');
    expect(second?.sequence).toBe(2);
  });

  it('drops a batch the server refuses for good (409, 400) and keeps one it could not reach (503)', async () => {
    const dir = home();
    recordIncident(dir, incident);
    const status = (code: number) =>
      (() => Promise.resolve(new Response('{}', { status: code }))) as unknown as typeof fetch;
    const at = (hours: number) => ({ now: () => new Date(Date.UTC(2026, 9, 19, hours)) });
    await reportHealth({ client: clientOver(status(503)), ...at(10) }, dir);
    expect(pendingBatch(dir)).toBeDefined();
    await reportHealth({ client: clientOver(status(409)), ...at(12) }, dir);
    expect(pendingBatch(dir)).toBeUndefined();
  });
});

describe('a capture that crashes before it commits loses nothing', () => {
  it('reads the kept file again', () => {
    const dir = home();
    recordIncident(dir, incident);
    // simulate the crash: the file was moved aside, no state was written
    renameSync(join(dir, 'ror-health.log'), join(dir, 'ror-health.log.taking'));
    const batch = captureBatch(dir, () => 'gen-AAAAAAAA');
    expect(batch?.incidents).toHaveLength(1);
  });

  it('refuses to write through a link planted at the temporary name of the state', () => {
    const dir = home();
    recordIncident(dir, incident);
    expect(captureBatch(dir, () => 'gen-AAAAAAAA')).toBeDefined();
  });
});

describe('review round 3', () => {
  it('a failure note never overwrites a newer pending batch', () => {
    const dir = home();
    recordIncident(dir, incident);
    const first = captureBatch(dir, () => 'gen-AAAAAAAA');
    if (first === undefined) throw new Error('expected a batch');
    settleBatch(dir, first);
    recordIncident(dir, { ...incident, code: 'internal_error' });
    const second = captureBatch(dir, () => 'gen-BBBBBBBB');
    expect(second?.sequence).toBe(2);
    // a late failure about the FIRST batch must not touch the second
    noteFailure(dir, Date.now(), first);
    expect(mayTry(dir, Date.now())).toBe(true);
    expect(pendingBatch(dir)?.sequence).toBe(2);
  });

  it('returns lines appended after the read to the live log, so the next capture has them', () => {
    const dir = home();
    recordIncident(dir, incident);
    const batch = captureBatch(dir, () => 'gen-AAAAAAAA');
    if (batch === undefined) throw new Error('expected a batch');
    settleBatch(dir, batch);
    // a hook that held the moved file appends to it between our read and our cleanup
    recordIncident(dir, { ...incident, code: 'internal_error' });
    const next = captureBatch(dir, () => 'unused-gen');
    expect(next?.incidents.map((each) => each.code)).toEqual(['internal_error']);
  });

  it('retires an empty taken file instead of stalling on it', () => {
    const dir = home();
    writeFileSync(join(dir, 'ror-health.log.taking'), '');
    recordIncident(dir, incident);
    expect(captureBatch(dir, () => 'gen-AAAAAAAA')?.incidents).toHaveLength(1);
  });

  it('reclaims orphan state temporaries and never grows past its bound', () => {
    const dir = home();
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(dir, `ror-health.json.dead${String(index)}.tmp`), 'x');
    }
    recordIncident(dir, incident);
    captureBatch(dir, () => 'gen-AAAAAAAA');
    const left = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    expect(left).toEqual([]);
  });

  it('refuses a line that would cross the bound, not only a full file', () => {
    const dir = home();
    writeFileSync(join(dir, 'ror-health.log'), 'x'.repeat(16 * 1024 - 5));
    recordIncident(dir, incident);
    expect(readFileSync(join(dir, 'ror-health.log'), 'utf8')).toHaveLength(16 * 1024 - 5);
  });
});

describe('requeueing stays inside the bound and the link rules', () => {
  it('never writes through a link planted at the live log', () => {
    const dir = home();
    recordIncident(dir, incident);
    const batch = captureBatch(dir, () => 'gen-AAAAAAAA');
    if (batch === undefined) throw new Error('expected a batch');
    // a late line is waiting in the taken file; the live log is a link to a victim
    writeFileSync(join(dir, 'ror-health.log.taking'), 'claude_code stop internal_error none\n');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(dir, 'ror-health.log'));
    captureBatch(dir, () => 'unused-gen');
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('marks the loss instead of overflowing when the live log cannot take the lines', () => {
    const dir = home();
    recordIncident(dir, incident);
    const batch = captureBatch(dir, () => 'gen-AAAAAAAA');
    if (batch === undefined) throw new Error('expected a batch');
    writeFileSync(join(dir, 'ror-health.log'), 'x'.repeat(16 * 1024 - 20));
    writeFileSync(join(dir, 'ror-health.log.taking'), 'claude_code stop internal_error none\n');
    captureBatch(dir, () => 'unused-gen');
    expect(readFileSync(join(dir, 'ror-health.log')).length).toBeLessThanOrEqual(16 * 1024);
  });

  it('never overflows on a full log, whatever the number of interrupted requeues', () => {
    const dir = home();
    recordIncident(dir, incident);
    captureBatch(dir, () => 'gen-AAAAAAAA');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      writeFileSync(join(dir, 'ror-health.log'), 'x'.repeat(16 * 1024 - 3));
      writeFileSync(join(dir, 'ror-health.log.taking'), 'claude_code stop internal_error none\n');
      captureBatch(dir, () => 'unused-gen');
      expect(readFileSync(join(dir, 'ror-health.log')).length).toBeLessThanOrEqual(16 * 1024);
    }
  });
});

describe('a pipe planted at the log is never waited on', () => {
  it.skipIf(process.platform === 'win32')('returns at once and writes nothing', () => {
    const dir = home();
    execFileSync('mkfifo', [join(dir, 'ror-health.log')]);
    const started = Date.now();
    recordIncident(dir, incident);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('reading never waits on a pipe nor follows a link', () => {
  it.skipIf(process.platform === 'win32')(
    'a pipe at the state or the taken file is refused at once',
    () => {
      const dir = home();
      execFileSync('mkfifo', [join(dir, 'ror-health.json')]);
      execFileSync('mkfifo', [join(dir, 'ror-health.log.taking')]);
      recordIncident(dir, incident);
      const started = Date.now();
      expect(mayTry(dir, Date.now())).toBe(true);
      const batch = captureBatch(dir, () => 'gen-AAAAAAAA');
      expect(Date.now() - started).toBeLessThan(2000);
      expect(batch?.incidents).toHaveLength(1);
    },
  );

  it('a link at the state file is not read', () => {
    const dir = home();
    const decoy = join(dir, 'decoy.json');
    writeFileSync(
      decoy,
      JSON.stringify({
        pending: {
          generation: 'gen-AAAAAAAA',
          sequence: 99,
          incidents: [],
          incomplete: false,
          saturated: false,
        },
      }),
    );
    symlinkSync(decoy, join(dir, 'ror-health.json'));
    expect(pendingBatch(dir)).toBeUndefined();
  });
});

describe('the loss signal covers the longest line', () => {
  it('reports saturation when the longest valid line no longer fits', () => {
    const dir = home();
    // 16,307 bytes: 65 left before the marker's room, and the longest line is 66
    writeFileSync(join(dir, 'ror-health.log'), 'x'.repeat(16307 - 1) + '\n');
    recordIncident(dir, {
      target: 'claude_code',
      hook: 'user_prompt_submit',
      code: 'version_incompatible',
      effect: 'failed_closed',
    });
    const batch = captureBatch(dir, () => 'gen-AAAAAAAA');
    expect(batch?.saturated).toBe(true);
  });
});
