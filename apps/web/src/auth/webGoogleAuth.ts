import type { EpochMs } from '@ankylock/core';
import { AuthError, type AuthTokens, type AuthTransport } from '@ankylock/sync';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPES = ['openid', 'email', DRIVE_APPDATA_SCOPE];
/** Name of the same-origin channel `public/oauth-callback.js` posts the result to. */
export const OAUTH_CHANNEL = 'ankylock-oauth';
const HINT_KEY = 'ankylock.google.loginHint';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** The parts of a popup window and a BroadcastChannel the flow uses; injectable for tests. */
export interface PopupLike {
  readonly closed: boolean;
  close(): void;
}

export interface ChannelLike {
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

export interface WebAuthOptions {
  /** OAuth client of type "Web application" (desktop clients only allow loopback redirects). */
  readonly clientId: string;
  /** `<origin>/oauth-callback.html`, registered as an authorized redirect URI of the client. */
  readonly redirectUri: string;
  readonly openPopup?: (url: string) => PopupLike | null;
  readonly openChannel?: () => ChannelLike;
  readonly fetch?: typeof fetch;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly now?: () => EpochMs;
  /** How often to check whether the user closed the popup (default 500 ms). */
  readonly pollMs?: number;
}

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Reads the (unverified) claims of a JWT; the relay verifies the signature. */
function claims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1];
  if (payload === undefined) throw new AuthError('ERR_AUTH', 'Google returned a malformed ID token.');
  try {
    const base64 = payload.replaceAll('-', '+').replaceAll('_', '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AuthError('ERR_AUTH', 'Google returned a malformed ID token.');
  }
}

function safely<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}

/**
 * Web Google sign-in without loading any Google script into the page that decrypts notes: one
 * popup runs the OAuth implicit flow for an ID token (relay) and a `drive.appdata` access token
 * (backup) together. Browsers get no refresh token, so the session cannot renew itself: when the
 * tokens expire the session turns `stale` and one click renews it (no consent screen again).
 * Tokens live in memory only; only the account email is remembered, as a sign-in hint.
 */
export function createWebAuthTransport(options: WebAuthOptions): AuthTransport {
  const now = options.now ?? ((): EpochMs => Date.now() as EpochMs);
  const openPopup =
    options.openPopup ?? ((url: string) => window.open(url, 'ankylock-google-sign-in', 'popup,width=480,height=640'));
  const openChannel = options.openChannel ?? ((): ChannelLike => new BroadcastChannel(OAUTH_CHANNEL));
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const storage = options.storage ?? safely(() => window.localStorage);
  const pollMs = options.pollMs ?? 500;
  let accessToken: string | null = null;

  /** Revoking the access token revokes the whole grant, not just this token. */
  const postRevoke = (token: string): Promise<Response> =>
    doFetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });

  function authorizeUrl(state: string, nonce: string): string {
    const hint = storage ? safely(() => storage.getItem(HINT_KEY)) : null;
    const params = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      response_type: 'token id_token',
      scope: SCOPES.join(' '),
      include_granted_scopes: 'true',
      state,
      nonce,
      ...(hint ? { login_hint: hint } : { prompt: 'select_account' }),
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Waits for the popup's result on the channel, or for the user to close the popup. */
  function awaitResult(popup: PopupLike, state: string): Promise<URLSearchParams> {
    const channel = openChannel();
    return new Promise<URLSearchParams>((resolve, reject) => {
      let closedSince: number | null = null;
      const finish = (): void => {
        clearInterval(poll);
        channel.close();
      };
      const poll = setInterval(() => {
        if (!popup.closed) return;
        // The result may still be in flight right after the popup closes itself.
        closedSince ??= Date.now();
        if (Date.now() - closedSince >= pollMs * 2) {
          finish();
          reject(new AuthError('ERR_AUTH', 'Google sign-in was cancelled.'));
        }
      }, pollMs);
      channel.onmessage = (event) => {
        const fragment = (event.data as { fragment?: unknown } | null)?.fragment;
        if (typeof fragment !== 'string') return;
        const params = new URLSearchParams(fragment);
        // Another sign-in attempt's result, or a forged one: not ours.
        if (params.get('state') !== state) return;
        finish();
        resolve(params);
      };
    });
  }

  function tokensFrom(params: URLSearchParams, nonce: string): AuthTokens {
    const error = params.get('error');
    if (error !== null) {
      throw new AuthError('ERR_AUTH', error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed (${error}).`);
    }
    const idToken = params.get('id_token');
    const token = params.get('access_token');
    const expiresIn = Number(params.get('expires_in'));
    if (!idToken || !token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new AuthError('ERR_AUTH', 'Google returned an incomplete sign-in response.');
    }
    if (!(params.get('scope') ?? '').split(' ').includes(DRIVE_APPDATA_SCOPE)) {
      throw new AuthError('ERR_AUTH', 'AnkyLock needs access to its own Google Drive folder to back up your vaults.');
    }
    const { aud, iss, nonce: tokenNonce, email } = claims(idToken);
    if (aud !== options.clientId || typeof iss !== 'string' || !ISSUERS.has(iss) || tokenNonce !== nonce) {
      throw new AuthError('ERR_AUTH', 'Google returned an ID token that was not issued for this sign-in.');
    }
    if (typeof email === 'string' && storage) safely(() => storage.setItem(HINT_KEY, email));
    accessToken = token;
    return { idToken, accessToken: token, expiresAt: (now() + expiresIn * 1000) as EpochMs };
  }

  return {
    canRefresh: false,

    async signIn() {
      const state = randomToken();
      const nonce = randomToken();
      const popup = openPopup(authorizeUrl(state, nonce));
      if (!popup) throw new AuthError('ERR_AUTH', 'Allow pop-ups for AnkyLock to sign in with Google.');
      try {
        return tokensFrom(await awaitResult(popup, state), nonce);
      } finally {
        if (!popup.closed) popup.close();
      }
    },

    // Without a refresh token there is nothing to restore silently after a reload.
    restore: async () => null,

    refresh: () => Promise.reject(new AuthError('ERR_AUTH_EXPIRED', 'Renew Google access to continue syncing.')),

    async signOut() {
      if (storage) safely(() => storage.removeItem(HINT_KEY));
      const token = accessToken;
      accessToken = null;
      // Best effort: the token expires within the hour anyway.
      if (token !== null) await postRevoke(token).catch(() => undefined);
    },

    async revoke() {
      if (accessToken !== null) {
        let response: Response;
        try {
          response = await postRevoke(accessToken);
        } catch {
          throw new AuthError('ERR_NETWORK', 'Could not reach Google to revoke AnkyLock’s access.');
        }
        if (!response.ok) throw new AuthError('ERR_AUTH', `Google did not revoke AnkyLock’s access (HTTP ${response.status}).`);
      }
      accessToken = null;
    },
  };
}
