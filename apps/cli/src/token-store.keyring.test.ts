import { beforeEach, describe, expect, it, vi } from 'vitest';

const { Entry, entries } = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const Entry = vi.fn(function (this: object, service: string, account: string) {
    const key = `${service}/${account}`;
    Object.assign(this, {
      getPassword: () => entries.get(key) ?? null,
      setPassword: (token: string) => entries.set(key, token),
      deletePassword: () => entries.delete(key),
    });
  });
  return { Entry, entries };
});
vi.mock('@napi-rs/keyring', () => ({ Entry }));

const { tokenStore } = await import('./token-store.js');

describe('the default backend is @napi-rs/keyring', () => {
  beforeEach(() => {
    entries.clear();
    Entry.mockClear();
  });

  it('keeps the token under service runonroad, account = origin, Secret Service on Linux', () => {
    const store = tokenStore({ configuredServer: 'https://a.example', env: {} });
    store.set('https://a.example:443/console', 'tok-a');

    expect(Entry).toHaveBeenCalledWith('runonroad', 'https://a.example', {
      linux: { store: 'secret-service' },
    });
    expect(store.get('https://a.example')).toBe('tok-a');
    expect(store.get('https://b.example')).toBeUndefined();
    expect(store.delete('https://a.example')).toBe(true);
    expect(entries.size).toBe(0);
  });
});
