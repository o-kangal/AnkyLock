import { describe, expect, it } from 'vitest';
import { createTauriAuthTransport, type Invoke } from '../src/googleAuthTransport.js';

const SESSION = { idToken: 'id', accessToken: 'at', expiresAt: 1_776_100_000_000 };

function fake(responses: Record<string, unknown>): { invoke: Invoke; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    invoke: async (command) => {
      calls.push(command);
      const response = responses[command];
      if (response instanceof Error || (typeof response === 'object' && response !== null && 'code' in response)) throw response;
      return response;
    },
  };
}

describe('createTauriAuthTransport', () => {
  it('maps IPC sessions to tokens', async () => {
    const { invoke, calls } = fake({ oauth_sign_in: SESSION, oauth_refresh: SESSION, oauth_restore: null, oauth_sign_out: null });
    const t = createTauriAuthTransport(invoke);
    expect(await t.signIn()).toEqual(SESSION);
    expect(await t.refresh()).toEqual(SESSION);
    expect(await t.restore()).toBeNull();
    await t.signOut();
    expect(calls).toEqual(['oauth_sign_in', 'oauth_refresh', 'oauth_restore', 'oauth_sign_out']);
  });

  it('maps host error codes, keeping expired distinct', async () => {
    const { invoke } = fake({
      oauth_refresh: { code: 'ERR_AUTH_EXPIRED', message: 'Your Google sign-in has expired. Please sign in again.' },
      oauth_sign_in: { code: 'ERR_AUTH', message: 'Google sign-in was cancelled.' },
    });
    const t = createTauriAuthTransport(invoke);
    await expect(t.refresh()).rejects.toMatchObject({ name: 'AuthError', code: 'ERR_AUTH_EXPIRED' });
    await expect(t.signIn()).rejects.toMatchObject({ code: 'ERR_AUTH', message: 'Google sign-in was cancelled.' });
  });

  it('rejects malformed responses', async () => {
    const { invoke } = fake({ oauth_sign_in: { idToken: 'x' } });
    await expect(createTauriAuthTransport(invoke).signIn()).rejects.toMatchObject({ code: 'ERR_AUTH' });
  });
});
