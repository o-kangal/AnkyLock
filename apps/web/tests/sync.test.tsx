import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { EpochMs, NoteId, VaultId } from '@ankylock/core';
import { CryptoError, createKeySealer, type WorkerSealer } from '@ankylock/crypto';
import { AuthError, TEXT_FIELD, createAuthSession, type AuthTransport, type SocketLike } from '@ankylock/sync';
import { SyncStatusBar } from '../src/components/SyncStatusBar.jsx';
import { UnlockScreen } from '../src/components/UnlockScreen.jsx';
import { createRuntime, type Runtime } from '../src/index.js';
import { FakeDrive, TestVaults } from './helpers.js';

/** In-memory blind relay shared by the runtimes in a test; like the real one, it fans out per URL (vault). */
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
    readonly url: string,
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
      if (s !== this && s.url === this.url && s.readyState === 1) s.onmessage?.({ data: data.slice().buffer } as MessageEvent);
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

function localSealer(): WorkerSealer {
  let current: CryptoKey | null = null;
  const inner = createKeySealer(() => {
    if (!current) throw new CryptoError('ERR_VAULT_LOCKED', 'locked');
    return current;
  });
  return { ...inner, setKey: async (k) => void (current = k), dispose: () => undefined };
}

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const PASSPHRASE = 'correct horse battery';

interface Device {
  readonly runtime: Runtime;
  readonly google: ReturnType<typeof fakeGoogle>;
  readonly sockets: FakeSocket[];
  readonly vaults: TestVaults;
}

function device(relay: FakeRelay, withAuth = true, drive?: FakeDrive): Device {
  const google = fakeGoogle();
  const sockets: FakeSocket[] = [];
  const vaults = new TestVaults();
  const runtime = createRuntime({
    vaults,
    sealer: localSealer(),
    ...(withAuth ? { auth: createAuthSession(google) } : {}),
    relayUrl: 'ws://relay.test/ws/',
    createSocket: (url, protocols) => {
      const socket = new FakeSocket(relay, url, protocols);
      sockets.push(socket);
      return socket;
    },
    driveFetch: drive?.fetch ?? (() => Promise.reject(new TypeError('offline'))),
  });
  return { runtime, google, sockets, vaults };
}

/** A device with a new vault of its own. */
async function withNewVault(relay: FakeRelay, name = 'Personal', withAuth = true, drive?: FakeDrive): Promise<Device> {
  const d = device(relay, withAuth, drive);
  await d.runtime.init();
  expect(await d.runtime.createVault(name, PASSPHRASE)).toBeNull();
  return d;
}

/**
 * Two devices on the same vault. The second gets the first one's (non-secret) header, as it will
 * from Google Drive (Task 11h), and derives the same key from the same passphrase.
 */
async function twoDevices(relay: FakeRelay, drive?: FakeDrive): Promise<readonly [Device, Device]> {
  const a = await withNewVault(relay, 'Personal', true, drive);
  const id = (await a.vaults.list())[0]?.id as VaultId;
  const b = device(relay, true, drive);
  const header = (await a.vaults.storage.getVaultHeader()) as string;
  await b.vaults.create(id, header, (await a.vaults.storage.getVaultName())!);
  await b.runtime.init();
  expect(await b.runtime.unlock(id, PASSPHRASE)).toBeNull();
  return [a, b];
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
    const id = (await a.vaults.list())[0]?.id as VaultId;
    expect(a.sockets[0]?.url).toBe(`ws://relay.test/ws/${id}`);

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
    const a = await withNewVault(relay);
    await a.runtime.signIn();
    await until(() => a.runtime.syncStatus().connection === 'open', 'online');
    await a.runtime.signOut();
    expect(a.google.signedOut).toBe(1);
    expect(a.runtime.syncStatus()).toMatchObject({ auth: 'signed-out', connection: 'off' });
    expect(relay.sockets.size).toBe(0);
    expect((await a.runtime.store.createTab()).ok).toBe(true);
    await a.runtime.lock();
  });

  it('backs up to Drive even while the relay is unreachable', async () => {
    const drive = new FakeDrive();
    const vaults = new TestVaults();
    const runtime = createRuntime({
      vaults,
      sealer: localSealer(),
      auth: createAuthSession(fakeGoogle()),
      relayUrl: 'ws://relay.test/ws',
      // A socket that never opens: the relay is down.
      createSocket: () => ({
        binaryType: 'blob',
        readyState: 0,
        onopen: null,
        onclose: null,
        onmessage: null,
        onerror: null,
        send: () => undefined,
        close: () => undefined,
      }),
      driveFetch: drive.fetch,
    });
    await runtime.init();
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    await runtime.signIn();
    await until(() => runtime.syncStatus().backup.kind === 'ok', 'backup while offline');
    expect(runtime.syncStatus().connection).not.toBe('open');
    expect(drive.names().some((n) => n.includes('.snapshot-'))).toBe(true);
    await runtime.lock();
  });

  it('keeps other vaults of the same account out of the channel', async () => {
    const relay = new FakeRelay();
    const [a, b] = await twoDevices(relay);
    const other = await withNewVault(relay, 'Work');
    for (const d of [a, b, other]) await d.runtime.signIn();
    await until(() => relay.sockets.size === 3 && other.runtime.syncStatus().connection === 'open', 'online');

    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    (await a.runtime.openDoc(noteId)).getText(TEXT_FIELD).insert(0, 'personal only');
    await until(() => b.runtime.store.state.notes[noteId] !== undefined, 'note on B');
    expect(await other.vaults.storage.getNote(noteId)).toBeNull();
    for (const d of [a, b, other]) await d.runtime.lock();
  });

  it('syncs folders and note placement made in the UI', async () => {
    const relay = new FakeRelay();
    const [a, b] = await twoDevices(relay);
    await a.runtime.signIn();
    await b.runtime.signIn();
    await until(() => relay.sockets.size === 2 && a.runtime.syncStatus().connection === 'open', 'online');
    expect((await a.runtime.store.createFolder('Projects', null, null)).ok).toBe(true);
    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    const folderId = a.runtime.store.state.folders[0]?.id ?? null;
    expect((await a.runtime.store.moveNote(noteId, folderId, null)).ok).toBe(true);

    await until(() => b.runtime.store.state.notes[noteId]?.folderId === folderId, 'filed on B');
    expect(b.runtime.store.state.folders.map((f) => f.name)).toEqual(['Projects']);
    await a.runtime.lock();
    await b.runtime.lock();
  });

  it('catches up from Drive on what changed while this device was closed', async () => {
    const relay = new FakeRelay();
    const drive = new FakeDrive();
    const [a, b] = await twoDevices(relay, drive);
    const id = b.runtime.vaults()[0]?.id as VaultId;
    await b.runtime.lock();

    // A works alone, then locks, which backs up to Drive.
    await a.runtime.signIn();
    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    (await a.runtime.openDoc(noteId)).getText(TEXT_FIELD).insert(0, 'written while B was closed');
    expect((await a.runtime.store.createFolder('Inbox', null, null)).ok).toBe(true);
    await a.runtime.lock();
    expect(relay.sockets.size).toBe(0);

    // B comes back with no other device online: everything arrives through Drive.
    expect(await b.runtime.unlock(id, PASSPHRASE)).toBeNull();
    await b.runtime.signIn();
    await until(() => b.runtime.store.state.notes[noteId] !== undefined, 'note caught up on B');
    expect(b.runtime.store.state.folders.map((f) => f.name)).toEqual(['Inbox']);
    expect((await b.runtime.openDoc(noteId)).getText(TEXT_FIELD).toString()).toBe('written while B was closed');
    await b.runtime.lock();
  });

  it('shows titles retitled on another device in the sidebar', async () => {
    const relay = new FakeRelay();
    const [a, b] = await twoDevices(relay);
    await a.runtime.signIn();
    await b.runtime.signIn();
    await until(() => relay.sockets.size === 2 && a.runtime.syncStatus().connection === 'open', 'online');
    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    const doc = (await a.runtime.openDoc(noteId)).getText(TEXT_FIELD);
    doc.insert(0, 'Shopping list');
    await until(() => b.runtime.store.state.notes[noteId] !== undefined, 'note on B');
    await b.runtime.store.loadTitle(noteId);
    await until(() => b.runtime.store.state.notes[noteId]?.title === 'Shopping list', 'first title on B');

    // The row already has a title; a remote retitle must still replace it.
    doc.delete(0, 'Shopping list'.length);
    doc.insert(0, 'Groceries');
    await until(() => b.runtime.store.state.notes[noteId]?.title === 'Groceries', 'retitled on B');
    await a.runtime.lock();
    await b.runtime.lock();
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
    const a = await withNewVault(new FakeRelay());
    const bar = mount(a.runtime);
    expect(bar.textContent).toContain('Not syncing');
    (Array.from(bar.querySelectorAll('button')).find((b) => b.textContent === 'Sign in with Google') as HTMLElement).click();
    await until(() => bar.textContent?.includes('Synced') === true, 'synced');
    expect(bar.textContent).toContain('Sign out');
    await a.runtime.lock();
  });

  it('shows the vault name and locks back to the vault list', async () => {
    const a = await withNewVault(new FakeRelay(), 'Work notes', false);
    const bar = mount(a.runtime);
    expect(bar.textContent).toContain('Work notes');
    (Array.from(bar.querySelectorAll('button')).find((b) => b.textContent === 'Lock') as HTMLElement).click();
    await until(() => a.runtime.status() === 'locked', 'locked');
    expect(a.runtime.vaultName()).toBeNull();
    expect(a.runtime.vaults()).toHaveLength(1);
  });

  it('says Local only without a Google session', async () => {
    const a = await withNewVault(new FakeRelay(), 'Personal', false);
    expect(mount(a.runtime).textContent).toContain('Local only');
    await a.runtime.lock();
  });
});

describe('opening an existing vault from Google Drive', () => {
  function type(root: HTMLElement, label: string, value: string): void {
    const input = root.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
  const click = (root: HTMLElement, text: string): void =>
    (Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLElement).click();
  const submit = (root: HTMLElement): void =>
    void root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

  it("restores another device's backup after checking the passphrase", async () => {
    const relay = new FakeRelay();
    const drive = new FakeDrive();
    const a = device(relay, true, drive);
    await a.runtime.init();
    expect(await a.runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    (await a.runtime.openDoc(noteId)).getText(TEXT_FIELD).insert(0, 'backed up text');
    await a.runtime.flush();
    await a.runtime.signIn();
    await until(() => a.runtime.syncStatus().backup.kind === 'ok', 'backup on A');
    expect(drive.names().filter((n) => n.endsWith('.header.json'))).toHaveLength(1);
    const [createdOnA] = a.runtime.vaults();
    await a.runtime.lock();

    const b = device(relay, true, drive);
    await b.runtime.init();
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = render(() => <UnlockScreen runtime={b.runtime} />, root);
    disposers.push(() => {
      dispose();
      root.remove();
    });
    expect(root.textContent).toContain('Create a vault');
    click(root, 'Use my existing vault');
    await until(() => root.querySelector('[aria-label="Vault in Google Drive"]') !== null, 'remote list');
    expect(root.textContent).toContain('last backup');

    type(root, 'Passphrase', 'not the passphrase');
    submit(root);
    await until(() => root.textContent?.includes('does not unlock') === true, 'wrong passphrase');
    expect(await b.vaults.list()).toEqual([]);

    type(root, 'Passphrase', PASSPHRASE);
    submit(root);
    await until(() => b.runtime.status() === 'unlocked', 'restored');
    expect(b.runtime.vaultName()).toBe('Personal');
    expect(b.runtime.vaults()[0]).toMatchObject({ id: createdOnA?.id, createdAt: createdOnA?.createdAt });
    expect((await b.runtime.openDoc(noteId)).getText(TEXT_FIELD).toString()).toBe('backed up text');

    // B backs up into its own snapshot file and leaves the header alone.
    await until(() => drive.names().filter((n) => n.includes('.snapshot-')).length === 2, 'B snapshot');
    expect(drive.names().filter((n) => n.endsWith('.header.json'))).toHaveLength(1);
    await b.runtime.lock();
  });
});
