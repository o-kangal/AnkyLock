import { IDBFactory } from 'fake-indexeddb';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { EpochMs, NoteId } from '@ankylock/core';
import { CryptoError, createKeySealer, type WorkerSealer } from '@ankylock/crypto';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import { AuthError, TEXT_FIELD, createAuthSession, type AuthTransport, type SocketLike } from '@ankylock/sync';
import { SyncStatusBar } from '../src/components/SyncStatusBar.jsx';
import { createRuntime, type Runtime } from '../src/index.js';

/** In-memory blind relay shared by the runtimes in a test. */
class FakeRelay {
  readonly sockets = new Set<FakeSocket>();
}

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(
    readonly relay: FakeRelay,
    readonly protocols: string[],
  ) {
    relay.sockets.add(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }

  send(data: Uint8Array | string): void {
    if (typeof data === 'string') return;
    for (const s of this.relay.sockets) {
      if (s !== this && s.readyState === 1) s.onmessage?.({ data: data.slice().buffer } as MessageEvent);
    }
  }

  close(): void {
    this.readyState = 3;
    this.relay.sockets.delete(this);
  }
}

function fakeGoogle(): AuthTransport & { signedOut: number } {
  const t = {
    signedOut: 0,
    signIn: async () => ({ idToken: 'id-token', accessToken: 'access-token', expiresAt: (Date.now() + 3_600_000) as EpochMs }),
    restore: async () => null,
    refresh: () => Promise.reject(new AuthError('ERR_AUTH_EXPIRED', 'expired')),
    signOut: async () => {
      t.signedOut++;
    },
  };
  return t;
}

function localSealer(key: CryptoKey): WorkerSealer {
  let current: CryptoKey | null = null;
  const inner = createKeySealer(() => {
    if (!current) throw new CryptoError('ERR_VAULT_LOCKED', 'locked');
    return current;
  });
  return { ...inner, setKey: async (k) => void (current = k ? key : null), dispose: () => undefined };
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Two devices of one user share the vault key (in the product via the same passphrase and
 * synced vault header). Here both sealers simply use the same CryptoKey.
 */
async function twoDevices(relay: FakeRelay, withAuth = true) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const make = async (): Promise<{ runtime: Runtime; google: ReturnType<typeof fakeGoogle>; sockets: FakeSocket[] }> => {
    const google = fakeGoogle();
    const sockets: FakeSocket[] = [];
    const runtime = createRuntime({
      storage: new WebIndexedDbAdapter(new IDBFactory()),
      sealer: localSealer(key),
      ...(withAuth ? { auth: createAuthSession(google) } : {}),
      relayUrl: 'ws://relay.test/ws',
      createSocket: (_url, protocols) => {
        const socket = new FakeSocket(relay, protocols);
        sockets.push(socket);
        return socket;
      },
      driveFetch: () => Promise.reject(new TypeError('offline')),
    });
    await runtime.init();
    expect(await runtime.createVault('correct horse battery')).toBeNull();
    return { runtime, google, sockets };
  };
  return [await make(), await make()] as const;
}

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

describe('runtime sync', () => {
  it('stays local-only until the user signs in, then syncs live edits', async () => {
    const relay = new FakeRelay();
    const [a, b] = await twoDevices(relay);
    expect(a.runtime.syncStatus()).toMatchObject({ auth: 'signed-out', connection: 'off' });
    expect(relay.sockets.size).toBe(0);

    expect(await a.runtime.signIn()).toBeNull();
    expect(await b.runtime.signIn()).toBeNull();
    await until(() => a.runtime.syncStatus().connection === 'open' && b.runtime.syncStatus().connection === 'open', 'both online');
    expect(a.sockets[0]?.protocols).toEqual(['ankylock.v1', 'id-token']);

    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    const docA = await a.runtime.openDoc(noteId);
    docA.getText(TEXT_FIELD).insert(0, 'const secret = 42;');

    // B learns about the note from the relay and shows it after a sidebar reload.
    await until(() => b.runtime.store.state.notes[noteId] !== undefined, 'note appears on B');
    const docB = await b.runtime.openDoc(noteId);
    expect(docB.getText(TEXT_FIELD).toString()).toBe('const secret = 42;');

    // Further edits arrive live in the open doc.
    docA.getText(TEXT_FIELD).insert(18, '\nconst other = 7;');
    await until(() => docB.getText(TEXT_FIELD).toString().endsWith('const other = 7;'), 'live edit on B');

    await a.runtime.lock();
    await b.runtime.lock();
  });

  it('stops syncing on sign-out but keeps working locally', async () => {
    const relay = new FakeRelay();
    const [a] = await twoDevices(relay);
    await a.runtime.signIn();
    await until(() => a.runtime.syncStatus().connection === 'open', 'online');
    await a.runtime.signOut();
    expect(a.google.signedOut).toBe(1);
    expect(a.runtime.syncStatus()).toMatchObject({ auth: 'signed-out', connection: 'off' });
    expect(relay.sockets.size).toBe(0);
    expect((await a.runtime.store.createTab()).ok).toBe(true);
    await a.runtime.lock();
  });

  it('announces purges to other devices', async () => {
    const relay = new FakeRelay();
    const [a, b] = await twoDevices(relay);
    await a.runtime.signIn();
    await b.runtime.signIn();
    await until(() => relay.sockets.size === 2 && a.runtime.syncStatus().connection === 'open', 'online');
    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    (await a.runtime.openDoc(noteId)).getText(TEXT_FIELD).insert(0, 'to be purged');
    await until(() => b.runtime.store.state.notes[noteId] !== undefined, 'note on B');

    await a.runtime.store.trashNote(noteId);
    await a.runtime.store.purgeNote(noteId);
    await until(() => b.runtime.store.state.notes[noteId] === undefined, 'purged on B');
    await a.runtime.lock();
    await b.runtime.lock();
  });
});

describe('SyncStatusBar', () => {
  function mount(runtime: Runtime): HTMLElement {
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = render(() => <SyncStatusBar runtime={runtime} />, root);
    disposers.push(() => {
      dispose();
      root.remove();
    });
    return root;
  }

  it('offers sign-in, shows the synced state and sign-out', async () => {
    const [a] = await twoDevices(new FakeRelay());
    const bar = mount(a.runtime);
    expect(bar.textContent).toContain('Not syncing');
    (Array.from(bar.querySelectorAll('button')).find((b) => b.textContent === 'Sign in with Google') as HTMLElement).click();
    await until(() => bar.textContent?.includes('Synced') === true, 'synced');
    expect(bar.textContent).toContain('Sign out');
    await a.runtime.lock();
  });

  it('says Local only without a Google session', async () => {
    const [a] = await twoDevices(new FakeRelay(), false);
    expect(mount(a.runtime).textContent).toContain('Local only');
    await a.runtime.lock();
  });
});
