import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochMs } from '@ankylock/core';
import { createWebAuthTransport, DRIVE_APPDATA_SCOPE, type ChannelLike } from '../src/auth/webGoogleAuth.js';

const CLIENT_ID = 'web-client.apps.googleusercontent.com';
const NOW = 1_776_100_000_000;

const b64url = (value: object): string =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const jwt = (claims: object): string => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;

/** Fakes the popup and the callback channel; `respond` plays Google redirecting back. */
function harness(revokeResponse: () => Promise<Response> = async () => new Response('')) {
  const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => revokeResponse());
  const storage = new Map<string, string>();
  const popup = { closed: false, close: vi.fn(() => void (popup.closed = true)) };
  let channel: ChannelLike | null = null;
  let url = '';
  const transport = createWebAuthTransport({
    clientId: CLIENT_ID,
    redirectUri: 'http://localhost:5173/oauth-callback.html',
    openPopup: (u) => {
      url = u;
      popup.closed = false;
      return popup;
    },
    openChannel: () => (channel = { onmessage: null, close: vi.fn() }),
    storage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: (k) => void storage.delete(k),
    },
    fetch,
    now: () => NOW as EpochMs,
    pollMs: 10,
  });
  const params = (): URLSearchParams => new URL(url).searchParams;
  const respond = (fields: Record<string, string>): void => {
    const fragment = new URLSearchParams(fields).toString();
    channel?.onmessage?.({ data: { fragment } } as MessageEvent);
  };
  const valid = (overrides: Record<string, string> = {}): Record<string, string> => ({
    state: params().get('state') ?? '',
    access_token: 'drive-token',
    expires_in: '3599',
    scope: `openid email ${DRIVE_APPDATA_SCOPE}`,
    id_token: jwt({ aud: CLIENT_ID, iss: 'https://accounts.google.com', nonce: params().get('nonce'), email: 'me@example.com' }),
    ...overrides,
  });
  return { transport, popup, storage, params, respond, valid, fetch };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('createWebAuthTransport', () => {
  it('gets the ID token and Drive token from one popup and remembers the account as a hint', async () => {
    const h = harness();
    const signingIn = h.transport.signIn();
    expect(h.params().get('response_type')).toBe('token id_token');
    expect(h.params().get('scope')).toBe(`openid email ${DRIVE_APPDATA_SCOPE}`);
    expect(h.params().get('prompt')).toBe('select_account');
    h.respond({ ...h.valid(), state: 'someone-else' });
    h.respond(h.valid());
    const tokens = await signingIn;
    expect(tokens).toMatchObject({ accessToken: 'drive-token', expiresAt: NOW + 3_599_000 });
    expect(h.transport.canRefresh).toBe(false);

    const again = h.transport.signIn();
    expect(h.params().get('login_hint')).toBe('me@example.com');
    expect(h.params().has('prompt')).toBe(false);
    h.respond(h.valid());
    await again;
  });

  it.each([
    [{ error: 'access_denied' }, 'cancelled'],
    [{ scope: 'openid email' }, 'Google Drive folder'],
    [{ id_token: jwt({ aud: 'other-client', iss: 'https://accounts.google.com' }) }, 'not issued for this sign-in'],
    [{ access_token: '' }, 'incomplete'],
  ])('rejects a bad response (%#)', async (overrides, message) => {
    const h = harness();
    const signingIn = h.transport.signIn();
    h.respond(h.valid(overrides));
    await expect(signingIn).rejects.toMatchObject({ code: 'ERR_AUTH', message: expect.stringContaining(message) });
    expect(h.popup.closed).toBe(true);
  });

  it('rejects a replayed ID token whose nonce belongs to another sign-in', async () => {
    const h = harness();
    const signingIn = h.transport.signIn();
    h.respond(h.valid({ id_token: jwt({ aud: CLIENT_ID, iss: 'https://accounts.google.com', nonce: 'old' }) }));
    await expect(signingIn).rejects.toMatchObject({ message: expect.stringContaining('not issued') });
  });

  it('reports a blocked or closed popup', async () => {
    const blocked = createWebAuthTransport({ clientId: CLIENT_ID, redirectUri: 'x', openPopup: () => null });
    await expect(blocked.signIn()).rejects.toMatchObject({ message: expect.stringContaining('pop-ups') });

    const h = harness();
    const signingIn = h.transport.signIn();
    const cancelled = expect(signingIn).rejects.toMatchObject({ message: 'Google sign-in was cancelled.' });
    h.popup.closed = true;
    await vi.advanceTimersByTimeAsync(50);
    await cancelled;
  });

  it('cannot refresh silently, restores nothing, and revokes on sign-out', async () => {
    const h = harness();
    await expect(h.transport.refresh()).rejects.toMatchObject({ code: 'ERR_AUTH_EXPIRED' });
    expect(await h.transport.restore()).toBeNull();
    const signingIn = h.transport.signIn();
    h.respond(h.valid());
    await signingIn;
    await h.transport.signOut();
    expect(h.storage.size).toBe(0);
  });

  it('revokes strictly: a failed revocation throws and keeps the token for a retry', async () => {
    let status = 503;
    const h = harness(async () => new Response('', { status }));
    const signingIn = h.transport.signIn();
    h.respond(h.valid());
    await signingIn;
    await expect(h.transport.revoke()).rejects.toMatchObject({ code: 'ERR_AUTH' });
    status = 200;
    await h.transport.revoke();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls[1]?.[1]?.body).toBe('token=drive-token');
    // Already revoked: signing out has nothing left to revoke.
    await h.transport.signOut();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});
