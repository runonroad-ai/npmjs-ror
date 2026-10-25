import { describe, expect, it, vi } from 'vitest';

import { apiClient } from './api.js';
import {
  answerDerogation,
  listDerogations,
  previewDerogation,
  showDerogation,
} from './derogation.js';

const ID = 'drg_01J9Z3K8QXV4WN7YBTR2M6ACDE';
const clientOver = (fetch: typeof globalThis.fetch) =>
  apiClient({
    server: 'http://api',
    tokens: { get: () => 'dev_x', set: () => undefined, delete: () => false },
    fetch,
  });
const item = (extra: object) => ({
  id: ID,
  ruleId: 'secure-coding@1.3.0:prod-db',
  governanceId: 'gov_01J9Z3K8QXV4WN7YBTR2M6ACDE',
  versionId: 'ver_01J9Z3K8QXV4WN7YBTR2M6ACDE',
  principalId: 'mbr_1',
  requestedBy: 'mbr_1',
  reason: 'migration window',
  note: null,
  answer: null,
  status: 'requested',
  decidedBy: null,
  decidedAt: null,
  startsAt: null,
  expiresAt: null,
  createdAt: '2026-10-21T10:00:00.000Z',
  ...extra,
});
const JSON_HEADERS = { 'content-type': 'application/json' };
const reply = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })),
  );

describe('ror derogation: the states of a request, as the mock-ups S005 to S010 show them', () => {
  it('previews a request without a network call', () => {
    const lines = previewDerogation('r@1:x', 'why');
    expect(lines[0]).toContain('not sent');
    expect(lines.join('\n')).toContain('r@1:x');
  });

  it('lists the requests with their state, wide enough for "clarification"', async () => {
    const fake = reply({ items: [item({ status: 'clarification' })], nextCursor: null });
    const { ok, lines } = await listDerogations({ client: clientOver(fake) }, undefined);
    expect(ok).toBe(true);
    expect(lines[0]).toContain('clarification secure-coding@1.3.0:prod-db');
  });

  it('shows what the approver said and how to answer a question', async () => {
    const fake = reply(item({ status: 'clarification', note: 'Which database exactly?' }));
    const { lines } = await showDerogation({ client: clientOver(fake) }, ID);
    expect(lines).toContain('approver Which database exactly?');
    expect(lines.join('\n')).toContain(`ror derogation answer ${ID} --text`);
  });

  it('shows a refusal reason, and tells a granted lease to be synced', async () => {
    const refused = await showDerogation(
      { client: clientOver(reply(item({ status: 'denied', note: 'Out of scope' }))) },
      ID,
    );
    expect(refused.lines).toContain('approver Out of scope');
    const granted = await showDerogation(
      {
        client: clientOver(
          reply(item({ status: 'granted', expiresAt: '2026-10-22T10:00:00.000Z' })),
        ),
      },
      ID,
    );
    expect(granted.lines.join('\n')).toContain('ror sync');
  });

  it('answers a question through the device token, and says a refusal plainly', async () => {
    const fake = reply(item({ answer: 'prod-db-2' }));
    const done = await answerDerogation({ client: clientOver(fake) }, ID, 'prod-db-2');
    expect(done.ok).toBe(true);
    const sent = fake.mock.calls[0]?.[0] as Request;
    expect(sent.url).toBe(`http://api/v1/derogations/${ID}/answer`);
    expect(sent.headers.get('authorization')).toBe('Bearer dev_x');
    expect(JSON.parse(await sent.text())).toEqual({ answer: 'prod-db-2' });
    const refused = await answerDerogation(
      { client: clientOver(reply({ code: 'derogation_not_found', status: 404 }, 404)) },
      'drg_9',
      'x',
    );
    expect(refused).toEqual({ ok: false, message: 'refused: derogation_not_found' });
  });

  it('writes what another person typed as one printable line, never a control sequence', async () => {
    const hostile = 'ask\u001b[2J\u001b]8;;http://x\u0007why\nnext';
    const shown = await showDerogation(
      {
        client: clientOver(
          reply(item({ status: 'clarification', reason: hostile, note: hostile, answer: hostile })),
        ),
      },
      ID,
    );
    for (const line of shown.lines) {
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    }
    expect(shown.lines.join('\n')).toContain('approver ask');
    const refused = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'x', detail: hostile }), {
          status: 409,
          headers: JSON_HEADERS,
        }),
      ),
    );
    const message = (await answerDerogation({ client: clientOver(refused) }, ID, 'y')).message;
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it('says "unexpected" for a 200 that is not JSON, and tells the refusals apart', async () => {
    const html = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<html>', { status: 200 })),
    );
    expect((await showDerogation({ client: clientOver(html) }, ID)).lines).toEqual([
      'the server answered something unexpected',
    ]);
    for (const status of [401, 404, 409]) {
      const refused = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(JSON.stringify({ code: `c${String(status)}` }), { status })),
      );
      const answered = await answerDerogation({ client: clientOver(refused) }, ID, 'x');
      expect(answered.ok).toBe(false);
      expect(answered.message).toContain(status === 401 ? 'ror login' : `c${String(status)}`);
    }
  });

  it('never leaves a call without a deadline', async () => {
    const seen = reply(item({}));
    await showDerogation({ client: clientOver(seen) }, ID);
    expect((seen.mock.calls[0]?.[0] as Request).signal).toBeInstanceOf(AbortSignal);
  });
});
