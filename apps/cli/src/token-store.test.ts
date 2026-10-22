import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type KeychainBackend, RorError, serverOrigin, tokenStore } from './token-store.js';

function memoryBackend(): KeychainBackend & { entries: Map<string, string>; reads: number } {
  const entries = new Map<string, string>();
  const backend = {
    entries,
    reads: 0,
    get: (account: string) => {
      backend.reads += 1;
      return entries.get(account);
    },
    set: (account: string, token: string) => {
      entries.set(account, token);
    },
    delete: (account: string) => entries.delete(account),
  };
  return backend;
}

const failing: KeychainBackend = {
  get: () => {
    throw new Error('no keychain');
  },
  set: () => {
    throw new Error('no keychain');
  },
  delete: () => {
    throw new Error('no keychain');
  },
};

const SERVER = 'https://a.example';

describe('a token is bound to the origin that issued it', () => {
  it('is returned for that origin and never for another scheme, host or port', () => {
    const store = tokenStore({ configuredServer: SERVER, backend: memoryBackend(), env: {} });
    store.set('https://a.example/console/devices', 'tok-a');

    expect(store.get('https://a.example')).toBe('tok-a');
    expect(store.get('https://a.example:443/mcp')).toBe('tok-a');
    for (const other of [
      'http://a.example',
      'https://b.example',
      'https://a.example.evil',
      'https://a.example:8443',
    ]) {
      expect(store.get(other)).toBeUndefined();
    }
  });

  it('keeps one entry per origin and deletes only that one', () => {
    const backend = memoryBackend();
    const store = tokenStore({ configuredServer: SERVER, backend, env: {} });
    store.set('https://a.example', 'tok-a');
    store.set('http://localhost:3000', 'tok-local');

    expect([...backend.entries.keys()]).toEqual(['https://a.example', 'http://localhost:3000']);
    expect(store.delete('https://a.example')).toBe(true);
    expect(store.get('https://a.example')).toBeUndefined();
    expect(store.get('http://localhost:3000')).toBe('tok-local');
  });

  it('refuses a URL that has no http(s) origin', () => {
    for (const bad of ['file:///etc/passwd', 'not a url', '']) {
      expect(() => serverOrigin(bad)).toThrow(expect.objectContaining({ code: 'ROR-E111' }));
    }
  });
});

describe('no store operation writes to disk', () => {
  let home: string | undefined;
  const savedHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = savedHome;
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  it('leaves a temporary home empty', () => {
    home = mkdtempSync(join(tmpdir(), 'ror-home-'));
    process.env.HOME = home;
    const store = tokenStore({ configuredServer: SERVER, backend: memoryBackend(), env: {} });

    store.set(SERVER, 'tok-a');
    store.get(SERVER);
    store.delete(SERVER);
    tokenStore({ configuredServer: SERVER, env: { RUNONROAD_TOKEN: 'tok-agent' } }).get(SERVER);

    expect(readdirSync(home, { recursive: true })).toEqual([]);
  });
});

describe('RUNONROAD_TOKEN', () => {
  it('is returned for the configured server without reading the keychain, and nowhere else', () => {
    const backend = memoryBackend();
    backend.entries.set('https://b.example', 'tok-b');
    const store = tokenStore({
      configuredServer: 'https://a.example/',
      backend,
      env: { RUNONROAD_TOKEN: 'tok-agent' },
    });

    expect(store.get('https://a.example/api')).toBe('tok-agent');
    expect(store.get('https://b.example')).toBeUndefined();
    expect(store.get('http://a.example')).toBeUndefined();
    expect(backend.reads).toBe(0);
  });

  it('counts as unset when empty', () => {
    const backend = memoryBackend();
    backend.entries.set(SERVER, 'tok-a');
    const store = tokenStore({ configuredServer: SERVER, backend, env: { RUNONROAD_TOKEN: '' } });
    expect(store.get(SERVER)).toBe('tok-a');
  });
});

describe('a missing keychain', () => {
  function storeError(store: ReturnType<typeof tokenStore>): RorError {
    try {
      store.set(SERVER, 'tok-a');
    } catch (error) {
      if (error instanceof RorError) return error;
      throw error;
    }
    throw new Error('storing a token did not fail');
  }

  it('fails storing with ROR-E110, pointing to RUNONROAD_TOKEN (injected backend)', () => {
    const error = storeError(tokenStore({ configuredServer: SERVER, backend: failing, env: {} }));
    expect(error.code).toBe('ROR-E110');
    expect(error.message).toContain('RUNONROAD_TOKEN');
  });

  // The real backend: with no session bus, Secret Service is unreachable (CI runs on Linux).
  it.runIf(process.platform === 'linux')(
    'fails storing with ROR-E110 on Linux without a session bus (real backend)',
    () => {
      const unset = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY'] as const;
      const saved = unset.map((name) => process.env[name]);
      for (const name of unset) Reflect.deleteProperty(process.env, name);
      try {
        const error = storeError(tokenStore({ configuredServer: SERVER, env: {} }));
        expect(error.code).toBe('ROR-E110');
        expect(error.message).toContain('RUNONROAD_TOKEN');
      } finally {
        unset.forEach((name, i) => {
          const value = saved[i];
          if (value !== undefined) process.env[name] = value;
        });
      }
    },
  );
});
