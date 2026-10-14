import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochMs } from '@ankylock/core';
import { AuthError, createAuthSession, type AuthState, type AuthTokens, type AuthTransport } from '../src/index.js';

const T0 = 1_776_100_000_000;
const HOUR = 3_600_000;

function tokens(n: number, expiresAt: number): AuthTokens {
  return { idToken: `id-${n}`, accessToken: `at-${n}`, expiresAt: expiresAt as EpochMs };
}

function transport(overrides: Partial<AuthTransport> = {}): AuthTransport & { refreshes: number } {
  let n = 0;
  const t = {
    refreshes: 0,
    signIn: async () => tokens(++n, Date.now() + HOUR),
    restore: async () => null,
    refresh: async () => {
      t.refreshes++;
      return tokens(++n, Date.now() + HOUR);
    },
    signOut: async () => undefined,
    ...overrides,
  };
  return t;
}

describe('createAuthSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs in, exposes tokens and reports state changes', async () => {
    const states: AuthState['kind'][] = [];
    const session = createAuthSession(transport());
    session.onChange((s) => states.push(s.kind));
    expect(() => session.idToken()).toThrow(AuthError);
    expect(await session.signIn()).toBeNull();
    expect(session.idToken()).toBe('id-1');
    expect(await session.accessToken()).toBe('at-1');
    expect(states).toEqual(['signing-in', 'signed-in']);
    session.dispose();
  });

  it('refreshes five minutes before expiry', async () => {
    const t = transport();
    const session = createAuthSession(t);
    await session.signIn();
    await vi.advanceTimersByTimeAsync(HOUR - 5 * 60_000 - 1);
    expect(t.refreshes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.refreshes).toBe(1);
    expect(session.idToken()).toBe('id-2');
    session.dispose();
  });

  it('refreshes before handing out a nearly expired access token', async () => {
    const t = transport({ signIn: async () => tokens(1, T0 + 60_000) });
    const session = createAuthSession(t);
    await session.signIn();
    expect(await session.accessToken()).toBe('at-1');
    expect(t.refreshes).toBe(1);
    session.dispose();
  });

  it('becomes expired when the grant was revoked', async () => {
    const t = transport({
      refresh: () => Promise.reject(new AuthError('ERR_AUTH_EXPIRED', 'revoked')),
    });
    const session = createAuthSession(t, { refreshMarginMs: HOUR });
    await session.signIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state()).toEqual({ kind: 'expired' });
    await expect(session.accessToken()).rejects.toMatchObject({ code: 'ERR_AUTH_EXPIRED' });
    session.dispose();
  });

  it('keeps the session and retries after a transient failure', async () => {
    let fail = true;
    const errors: unknown[] = [];
    const t = transport();
    const original = t.refresh;
    t.refresh = () => (fail ? Promise.reject(new AuthError('ERR_NETWORK', 'offline')) : original());
    const session = createAuthSession(t, { refreshMarginMs: HOUR, retryMs: 1000, onError: (e) => errors.push(e) });
    await session.signIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state().kind).toBe('signed-in');
    expect(errors).toHaveLength(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.idToken()).toBe('id-2');
    session.dispose();
  });

  it('restores silently, and signs out', async () => {
    const signOut = vi.fn(async () => undefined);
    const session = createAuthSession(transport({ restore: async () => tokens(7, T0 + HOUR), signOut }));
    await session.restore();
    expect(session.idToken()).toBe('id-7');
    await session.signOut();
    expect(session.state()).toEqual({ kind: 'signed-out' });
    expect(signOut).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a failed or cancelled sign-in without signing in', async () => {
    const session = createAuthSession(transport({ signIn: () => Promise.reject(new AuthError('ERR_AUTH', 'Google sign-in was cancelled.')) }));
    expect(await session.signIn()).toBe('Google sign-in was cancelled.');
    expect(session.state()).toEqual({ kind: 'signed-out' });
  });
});
