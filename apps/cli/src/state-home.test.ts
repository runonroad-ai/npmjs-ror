import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConfig, readPinnedKeys, writeLogin } from './state.js';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ror-state-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const login = { server: 'https://ror.example', organization: 'org_x', device: 'dev_x' };
const pinned = { organization_id: 'org_x', keys: [] };

describe('where the enrolment lives', () => {
  it('is <home>/.runonroad when RUNONROAD_HOME is not set', () => {
    const home = temp();
    writeLogin(home, login, pinned);
    expect(readdirSync(join(home, '.runonroad')).sort()).toEqual([
      'config.yaml',
      'signing-keys.json',
    ]);
    expect(readConfig(home).server).toBe(login.server);
  });

  it('is RUNONROAD_HOME when it is set, the place the hook reads the pinned keys', () => {
    const home = temp();
    const ror = temp();
    vi.stubEnv('RUNONROAD_HOME', ror);
    writeLogin(home, login, pinned);
    expect(readdirSync(ror).sort()).toEqual(['config.yaml', 'signing-keys.json']);
    expect(readdirSync(home)).toEqual([]);
    expect(readConfig(home).server).toBe(login.server);
    expect(readPinnedKeys(home)?.organization_id).toBe('org_x');
  });
});
