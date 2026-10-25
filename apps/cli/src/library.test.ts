import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LibraryDocument, SigningKey } from '@runonroad/api-contract';
import {
  checkTree,
  folderOf,
  profileFindings,
  secretFindings,
  slugOf,
  treeDigest,
  type SkillFileInput,
} from '@runonroad/skills';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activateSkill,
  diffSkill,
  editSkill,
  findSkill,
  loadLock,
  newSkill,
  syncLibrary,
  type LibraryEnv,
} from './library.js';
import type { Enrolment } from './session.js';

// ------------------------------------------------------------ a server in memory

interface Stored {
  slug: string;
  name: string;
  revisions: SkillFileInput[][];
  exposed: number | null;
  enabled: boolean;
  deleted: boolean;
}

class FakeServer {
  readonly skills = new Map<string, Stored>();
  readonly sent: { method: string; path: string }[] = [];
  private readonly pair = generateKeyPairSync('ed25519');
  private next = 0;
  issued = Date.parse('2026-10-19T10:00:00Z');
  member = 'mbr_1';
  tamper = false;

  readonly key: SigningKey = (() => {
    const jwk = this.pair.publicKey.export({ format: 'jwk' }) as { x: string };
    return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: 'test-key', use: 'sig', alg: 'EdDSA' };
  })();

  add(name: string, files: SkillFileInput[]): string {
    const id = `skl_${String((this.next += 1)).padStart(26, '0')}`;
    this.skills.set(id, {
      slug: slugOf(name),
      name,
      revisions: [files],
      exposed: 1,
      enabled: true,
      deleted: false,
    });
    return id;
  }

  private document(): LibraryDocument {
    return {
      library_version: 1,
      organization_id: 'org_1',
      member_id: this.member,
      issued_at: new Date(this.issued).toISOString(),
      skills: [...this.skills.entries()]
        .filter(([, s]) => !s.deleted && s.exposed !== null)
        .map(([id, s]) => {
          const files = s.revisions[(s.exposed ?? 1) - 1] ?? [];
          return {
            id,
            slug: s.slug,
            folder: folderOf(s.slug),
            name: s.name,
            description: '',
            revision: s.exposed ?? 1,
            tree_digest: treeDigest(files) as `sha256:${string}`,
            enabled: s.enabled,
            files: s.enabled ? files : [],
          };
        }),
      removed: [...this.skills.entries()].filter(([, s]) => s.deleted).map(([id]) => id),
    };
  }

  fetch: typeof fetch = async (input, init) => {
    // the generated client hands over a Request: read it the way a server would
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const bodyText =
      request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    const method = request.method;
    const path = url.pathname;
    this.sent.push({ method, path });
    const json = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const headers = request.headers;
    if (path === '/v1/library' && method === 'GET') {
      const stable = JSON.stringify({ ...this.document(), issued_at: '' });
      const etag = `"sha256:${createHash('sha256').update(stable).digest('hex')}"`;
      if (headers.get('if-none-match') === etag)
        return Promise.resolve(new Response(null, { status: 304, headers: { etag } }));
      const body = Buffer.from(JSON.stringify(this.document()));
      const signature = sign(
        null,
        this.tamper ? Buffer.from('other') : body,
        this.pair.privateKey,
      ).toString('base64url');
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { etag, 'runonroad-signature': `keyid="test-key", sig="${signature}"` },
        }),
      );
    }
    const payload =
      bodyText === undefined || bodyText === ''
        ? undefined
        : (JSON.parse(bodyText) as Record<string, unknown>);
    const refuse = (files: SkillFileInput[]) => [...checkTree(files), ...secretFindings(files)];
    if (path === '/v1/library/skills' && method === 'POST') {
      const files = payload?.['files'] as SkillFileInput[];
      if (refuse(files).length > 0) return json(422, { code: 'invalid_skill' });
      const name = String(payload?.['name']);
      if ([...this.skills.values()].some((s) => !s.deleted && s.slug === slugOf(name)))
        return json(409, { code: 'skill_slug_taken' });
      const id = this.add(name, files);
      const stored = this.skills.get(id);
      if (stored !== undefined && profileFindings(files).length > 0) stored.exposed = null;
      return json(201, {
        id,
        slug: slugOf(name),
        current_revision: 1,
        exposed_revision: stored?.exposed ?? null,
      });
    }
    const match = /^\/v1\/library\/skills\/([^/]+)(\/enabled)?$/u.exec(path);
    const stored = match?.[1] === undefined ? undefined : this.skills.get(match[1]);
    if (match !== null && stored !== undefined && !stored.deleted) {
      if (method === 'DELETE') {
        stored.deleted = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (match[2] !== undefined && method === 'PUT') {
        stored.enabled = payload?.['enabled'] === true;
        return json(200, { id: match[1] });
      }
      if (method === 'PUT') {
        if (payload?.['base_revision'] !== stored.revisions.length)
          return json(409, { code: 'skill_conflict' });
        const files = payload['files'] as SkillFileInput[];
        if (refuse(files).length > 0) return json(422, { code: 'invalid_skill' });
        stored.revisions.push(files);
        if (profileFindings(files).length === 0) stored.exposed = stored.revisions.length;
        return json(200, {
          id: match[1],
          slug: stored.slug,
          current_revision: stored.revisions.length,
          exposed_revision: stored.exposed,
        });
      }
    }
    return json(404, { code: 'skill_not_found' });
  };

  touch(): void {
    this.issued += 60_000;
  }
}

// ------------------------------------------------------------ the device

const folders: string[] = [];
let server: FakeServer;
let root: string;
let ror: string;
let env: LibraryEnv;
let enrolment: Enrolment;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ror-library-'));
  folders.push(base);
  ror = join(base, '.runonroad');
  process.env['RUNONROAD_HOME'] = ror;
  root = join(base, '.claude', 'skills');
  mkdirSync(root, { recursive: true });
  server = new FakeServer();
  env = { fetch: server.fetch, now: () => new Date('2026-10-19T12:00:00Z'), skillsRoot: root };
  enrolment = {
    api: 'https://ror.example',
    device_token: 'dev-token',
    organization_id: 'org_1',
    keys: [server.key],
  };
});
afterEach(() => {
  delete process.env['RUNONROAD_HOME'];
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const skill = (extra = ''): SkillFileInput[] => [
  {
    path: 'SKILL.md',
    content: `---\nname: devis\ndescription: Write a quote\n---\n# Devis\n${extra}`,
  },
  { path: 'references/tarifs.md', content: 'Tarifs 2026' },
];
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const kept = (kind: 'conflicts' | 'quarantine'): string[] =>
  existsSync(join(ror, 'library', kind)) ? readdirSync(join(ror, 'library', kind)) : [];

describe('down: the signed library becomes folders', () => {
  it('writes each exposed skill whole, remembers it, and answers up to date the second time', async () => {
    server.add('Rédiger un devis', skill());
    const first = await syncLibrary(env, enrolment);
    expect(first.code).toBe(0);
    expect(read('ror-lib-rediger-un-devis/SKILL.md')).toContain('# Devis');
    expect(read('ror-lib-rediger-un-devis/references/tarifs.md')).toBe('Tarifs 2026');
    expect(Object.values(loadLock().skills)[0]).toMatchObject({
      folder: 'ror-lib-rediger-un-devis',
      revision: 1,
    });
    const second = await syncLibrary(env, enrolment);
    expect(second).toEqual({ code: 0, lines: ['library: up to date'] });
  });

  it('makes the skills folder itself when only its parent exists, and refuses when there is no parent', async () => {
    server.add('Rédiger un devis', skill());
    rmSync(root, { recursive: true });
    const made = await syncLibrary(env, enrolment);
    expect(made.code, made.lines.join(' | ')).toBe(0);
    expect(read('ror-lib-rediger-un-devis/SKILL.md')).toContain('# Devis');
    // no `.claude` at all: the tool is not installed, and nothing is created for it
    const nowhere = join(mkdtempSync(join(tmpdir(), 'ror-library-')), 'nothing', 'skills');
    folders.push(join(nowhere, '..', '..'));
    server.add('Une autre méthode', skill());
    const refused = await syncLibrary({ ...env, skillsRoot: nowhere }, enrolment);
    expect(refused.code).not.toBe(0);
    expect(existsSync(join(nowhere, '..'))).toBe(false);
  });

  it('removes a skill that was switched off or deleted, and leaves every other folder alone', async () => {
    const off = server.add('Off', skill());
    const gone = server.add('Gone', skill());
    mkdirSync(join(root, 'my-own-skill'));
    writeFileSync(join(root, 'my-own-skill', 'SKILL.md'), 'mine');
    await syncLibrary(env, enrolment);
    expect(existsSync(join(root, 'ror-lib-off'))).toBe(true);
    const stored = server.skills.get(off);
    if (stored !== undefined) stored.enabled = false;
    const goneStored = server.skills.get(gone);
    if (goneStored !== undefined) goneStored.deleted = true;
    server.touch();
    const outcome = await syncLibrary(env, enrolment);
    expect(outcome.code).toBe(0);
    expect(existsSync(join(root, 'ror-lib-off'))).toBe(false);
    expect(existsSync(join(root, 'ror-lib-gone'))).toBe(false);
    expect(read('my-own-skill/SKILL.md')).toBe('mine');
    // switched on again, it comes back
    if (stored !== undefined) stored.enabled = true;
    server.touch();
    await syncLibrary(env, enrolment);
    expect(existsSync(join(root, 'ror-lib-off', 'SKILL.md'))).toBe(true);
  });

  it('refuses a library whose signature does not match, and touches nothing', async () => {
    server.add('Devis', skill());
    server.tamper = true;
    const outcome = await syncLibrary(env, enrolment);
    expect(outcome.code).toBe(32);
    expect(existsSync(join(root, 'ror-lib-devis'))).toBe(false);
  });

  it('refuses an older library than the one applied, and another person’s library', async () => {
    server.add('Devis', skill());
    await syncLibrary(env, enrolment);
    const stored = [...server.skills.values()][0];
    stored?.revisions.push(skill('v2'));
    if (stored !== undefined) stored.exposed = 2;
    server.issued -= 120_000;
    expect((await syncLibrary(env, enrolment)).code).toBe(32);
    server.issued += 240_000;
    server.member = 'mbr_other';
    expect((await syncLibrary(env, enrolment)).code).toBe(31);
  });

  it('keeps a different copy that was already in a folder of ours but never written by ror', async () => {
    server.add('Devis', skill());
    mkdirSync(join(root, 'ror-lib-devis'));
    writeFileSync(join(root, 'ror-lib-devis', 'SKILL.md'), '---\nname: devis\n---\nhand made');
    // it is sent as a new skill first: the name is taken, so a copy of it is set aside; ror did not write
    // the folder, so it does not overwrite it (ADR-0007): the server's version waits aside too
    const outcome = await syncLibrary(env, enrolment);
    expect(outcome.code).toBe(30);
    expect(kept('quarantine').length + kept('conflicts').length).toBe(2);
    expect(read('ror-lib-devis/SKILL.md')).toContain('hand made');
  });
});

describe('up: what the person edits or creates goes to the library', () => {
  it('sends an edit made in place, from the revision this device knows', async () => {
    const id = server.add('Devis', skill());
    await syncLibrary(env, enrolment);
    writeFileSync(join(root, 'ror-lib-devis', 'references', 'tarifs.md'), 'Tarifs 2027');
    const outcome = await syncLibrary(env, enrolment);
    expect(outcome.code).toBe(0);
    expect(server.skills.get(id)?.revisions).toHaveLength(2);
    expect(
      server.skills.get(id)?.revisions[1]?.find((f) => f.path === 'references/tarifs.md')?.content,
    ).toBe('Tarifs 2027');
    expect(loadLock().skills[id]?.revision).toBe(2);
    expect(await syncLibrary(env, enrolment)).toEqual({ code: 0, lines: ['library: up to date'] });
  });

  it('sets the local copy aside when the library moved too, and exposes the server’s', async () => {
    const id = server.add('Devis', skill());
    await syncLibrary(env, enrolment);
    writeFileSync(join(root, 'ror-lib-devis', 'references', 'tarifs.md'), 'mine');
    const stored = server.skills.get(id);
    stored?.revisions.push(skill('from the web'));
    if (stored !== undefined) stored.exposed = 2;
    server.touch();
    const outcome = await syncLibrary(env, enrolment);
    expect(outcome.code).toBe(30);
    expect(outcome.lines.join('\n')).toContain('changed elsewhere too');
    expect(kept('conflicts')).toHaveLength(1);
    const conflict = join(ror, 'library', 'conflicts', kept('conflicts')[0] ?? '');
    expect(readFileSync(join(conflict, 'references', 'tarifs.md'), 'utf8')).toBe('mine');
    expect(read('ror-lib-devis/SKILL.md')).toContain('from the web');
  });

  it('does not send a tree with a secret, and says nothing of it', async () => {
    const id = server.add('Devis', skill());
    await syncLibrary(env, enrolment);
    const secret = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    writeFileSync(join(root, 'ror-lib-devis', 'references', 'tarifs.md'), `key ${secret}`);
    server.sent.length = 0;
    const outcome = await syncLibrary(env, enrolment);
    expect(outcome.code).toBe(30);
    expect(outcome.lines.join('\n')).toContain('secret_suspected');
    expect(outcome.lines.join('\n')).not.toContain(secret);
    expect(server.sent.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(server.skills.get(id)?.revisions).toHaveLength(1);
    expect(kept('quarantine')).toHaveLength(1);
    expect(read('ror-lib-devis/references/tarifs.md')).toBe('Tarifs 2026');
  });

  it('does not send a skill that asks for hooks', async () => {
    server.add('Devis', skill());
    await syncLibrary(env, enrolment);
    writeFileSync(join(root, 'ror-lib-devis', 'SKILL.md'), '---\nname: devis\nhooks: x\n---\nbody');
    const outcome = await syncLibrary(env, enrolment);
    expect(outcome.lines.join('\n')).toContain('hooks_forbidden');
    expect(read('ror-lib-devis/SKILL.md')).toContain('# Devis');
  });

  it('creates on the server a skill folder made by hand or by `ror skills new`', async () => {
    const made = newSkill(env, 'Mon assistant');
    writeFileSync(
      join(made.dir, 'SKILL.md'),
      '---\nname: Mon assistant\ndescription: x\n---\nBody',
    );
    const outcome = await syncLibrary(env, enrolment);
    expect(outcome.code).toBe(0);
    expect([...server.skills.values()].map((s) => s.slug)).toEqual(['mon-assistant']);
    expect(Object.values(loadLock().skills)[0]?.revision).toBe(1);
  });

  it('keeps the work when the server is unreachable, and sends it later', async () => {
    const id = server.add('Devis', skill());
    await syncLibrary(env, enrolment);
    writeFileSync(join(root, 'ror-lib-devis', 'references', 'tarifs.md'), 'later');
    const online = env.fetch;
    env = { ...env, fetch: () => Promise.reject(new Error('offline')) };
    const outcome = await syncLibrary(env, enrolment);
    expect(outcome.code).toBe(31);
    expect(read('ror-lib-devis/references/tarifs.md')).toBe('later');
    env = { ...env, fetch: online };
    await syncLibrary(env, enrolment);
    expect(server.skills.get(id)?.revisions).toHaveLength(2);
  });
});

describe('a working copy outside discovery', () => {
  it('is edited freely, compared, validated whole and exposed as a snapshot', async () => {
    server.add('Devis', skill());
    await syncLibrary(env, enrolment);
    const ref = findSkill('devis');
    expect(ref).toBeDefined();
    if (ref === undefined) return;
    const work = editSkill(env, ref);
    writeFileSync(join(work, 'references', 'tarifs.md'), 'Tarifs W');
    // the tool's folder is unchanged until activation
    expect(read('ror-lib-devis/references/tarifs.md')).toBe('Tarifs 2026');
    expect(diffSkill(env, ref)).toEqual({
      exposed: { added: [], removed: [], changed: [] },
      work: { added: [], removed: [], changed: ['references/tarifs.md'] },
    });
    expect(activateSkill(env, ref)).toEqual({ ok: true });
    expect(read('ror-lib-devis/references/tarifs.md')).toBe('Tarifs W');
    await syncLibrary(env, enrolment);
    expect([...server.skills.values()][0]?.revisions).toHaveLength(2);
  });

  it('refuses to activate a working copy that breaks the rules, and leaves both untouched', async () => {
    server.add('Devis', skill());
    await syncLibrary(env, enrolment);
    const ref = findSkill('devis');
    if (ref === undefined) throw new Error('missing');
    const work = editSkill(env, ref);
    writeFileSync(join(work, 'SKILL.md'), '---\nname: devis\nallowed-tools: Bash\n---\nbody');
    const result = activateSkill(env, ref);
    expect(result).toMatchObject({ ok: false });
    expect(read('ror-lib-devis/SKILL.md')).toContain('# Devis');
    expect(readFileSync(join(work, 'SKILL.md'), 'utf8')).toContain('allowed-tools');
  });
});
