import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpochMs, NoteId, VaultId } from '@ankylock/core';
import { TEXT_FIELD, createAuthSession, type SocketLike } from '@ankylock/sync';
import { SyncStatusBar } from '../src/components/SyncStatusBar.jsx';
import { UnlockScreen } from '../src/components/UnlockScreen.jsx';
import { VaultSettings } from '../src/components/VaultSettings.jsx';
import { createRuntime, buildRelayUrl, parseRelayUrl, type Runtime } from '../src/index.js';
import type { RelayPreference } from '../src/preferences/devicePreferences.js';
import { CATCH_UP_INTERVAL_MS } from '../src/runtime/createRuntime.js';
import { FakeDrive, PASSPHRASE, TestVaults, fakeGoogle, localSealer, until } from './helpers.js';

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

  it('offers Sync now while syncing, and shows progress while it runs', async () => {
    const a = await withNewVault(new FakeRelay(), 'Personal', true, new FakeDrive());
    const bar = mount(a.runtime);
    // The visible backup label; the box also holds hidden sizing text.
    const label = (): string => bar.querySelector('[data-backup-label] > span:last-child')?.textContent ?? '';
    const syncButton = (): HTMLButtonElement | null => bar.querySelector('[aria-label="Sync now"]');
    expect(syncButton()).toBeNull();
    await a.runtime.signIn();
    await until(() => label().startsWith('Backed up'), 'first backup');

    syncButton()?.click();
    // The same button spins in place while it runs.
    expect(syncButton()?.getAttribute('aria-busy')).toBe('true');
    expect(syncButton()?.disabled).toBe(true);
    expect(label()).toBe('Syncing…');
    await until(() => label().startsWith('Backed up') && syncButton()?.getAttribute('aria-busy') === 'false', 'synced again');
    expect(syncButton()?.disabled).toBe(false);
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

describe('Drive-only sync (no relay)', () => {
  /** Remembers the own-relay choice in memory, as localStorage would. */
  function memoryRelayPreference(initial: string | null = null): RelayPreference {
    const [url, setUrl] = createSignal<string | null>(initial);
    return { url, set: setUrl };
  }

  function driveDevice(drive: FakeDrive, relayPreference: RelayPreference = memoryRelayPreference()) {
    const vaults = new TestVaults();
    const sockets: string[] = [];
    const runtime = createRuntime({
      vaults,
      sealer: localSealer(),
      auth: createAuthSession(fakeGoogle()),
      relayPreference,
      driveFetch: drive.fetch,
      createSocket: (url) => {
        sockets.push(url);
        return {
          binaryType: 'blob',
          readyState: 0,
          onopen: null,
          onclose: null,
          onmessage: null,
          onerror: null,
          send: () => undefined,
          close: () => undefined,
        };
      },
    });
    return { runtime, vaults, sockets };
  }

  async function sharedDriveVault(drive: FakeDrive) {
    const a = driveDevice(drive);
    await a.runtime.init();
    expect(await a.runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    await a.runtime.signIn();
    await until(() => a.runtime.syncStatus().backup.kind === 'ok', 'A backed up');
    const id = a.runtime.vaults()[0]?.id as VaultId;
    const b = driveDevice(drive);
    await b.runtime.init();
    await b.runtime.findRemoteVaults();
    expect(await b.runtime.openRemoteVault(id, PASSPHRASE)).toBeNull();
    await until(() => b.runtime.syncStatus().backup.kind === 'ok', 'B backed up');
    return { a, b, id };
  }

  it('syncs two devices through Google Drive without ever opening a relay connection', async () => {
    const { a, b } = await sharedDriveVault(new FakeDrive());
    expect(a.runtime.syncStatus()).toMatchObject({ mode: 'drive', connection: 'off' });
    expect(a.runtime.syncStatus().lastCatchUpAt).not.toBeNull();

    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    (await a.runtime.openDoc(noteId)).getText(TEXT_FIELD).insert(0, 'from A, via Drive');
    await a.runtime.flush();
    await a.runtime.syncNow();

    await b.runtime.syncNow();
    expect((await b.runtime.openDoc(noteId)).getText(TEXT_FIELD).toString()).toBe('from A, via Drive');
    expect([...a.sockets, ...b.sockets]).toEqual([]);
    await Promise.all([a.runtime.lock(), b.runtime.lock()]);
  });

  it('catches up on a regular interval while no relay is set', async () => {
    const { a, b } = await sharedDriveVault(new FakeDrive());
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      // Started before the fake clock: lock and unlock to restart sync under it.
      await a.runtime.lock();
      const id = a.runtime.vaults()[0]?.id as VaultId;
      expect(await a.runtime.unlock(id, PASSPHRASE)).toBeNull();
      await until(() => a.runtime.syncStatus().lastCatchUpAt !== null, 'first catch-up');
      const first = a.runtime.syncStatus().lastCatchUpAt ?? 0;
      await new Promise((r) => setTimeout(r, 5));
      vi.advanceTimersByTime(CATCH_UP_INTERVAL_MS);
      await until(() => (a.runtime.syncStatus().lastCatchUpAt ?? 0) > first, 'interval catch-up');
    } finally {
      vi.useRealTimers();
    }
    await Promise.all([a.runtime.lock(), b.runtime.lock()]);
  });

  it("uses the user's own relay once set, and goes back to Drive only when it is removed", async () => {
    const drive = new FakeDrive();
    const relayPreference = memoryRelayPreference();
    const a = driveDevice(drive, relayPreference);
    await a.runtime.init();
    expect(await a.runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    await a.runtime.signIn();
    await until(() => a.runtime.syncStatus().mode === 'drive', 'drive sync');
    const id = a.runtime.vaults()[0]?.id as VaultId;

    expect(await a.runtime.setOwnRelay('http://relay.example/ws')).toMatch(/wss:\/\//);
    expect(await a.runtime.setOwnRelay('ws://relay.example/ws')).toMatch(/wss:\/\//);
    expect(relayPreference.url()).toBeNull();

    expect(await a.runtime.setOwnRelay(' wss://relay.example/ws/ ')).toBeNull();
    expect(relayPreference.url()).toBe('wss://relay.example/ws');
    expect(a.runtime.ownRelayUrl()).toBe('wss://relay.example/ws');
    await until(() => a.sockets.length === 1, 'relay socket');
    expect(a.sockets[0]).toBe(`wss://relay.example/ws/${id}`);
    expect(a.runtime.syncStatus().mode).toBe('live');

    expect(await a.runtime.setOwnRelay('')).toBeNull();
    expect(relayPreference.url()).toBeNull();
    expect(a.runtime.syncStatus()).toMatchObject({ mode: 'drive', connection: 'off' });
    expect(a.sockets).toHaveLength(1);
    await a.runtime.lock();
  });
});

describe('relay settings', () => {
  async function settingsFor(relayPreference?: RelayPreference): Promise<{ root: HTMLElement; runtime: Runtime }> {
    const runtime = createRuntime({
      vaults: new TestVaults(),
      sealer: localSealer(),
      auth: createAuthSession(fakeGoogle()),
      ...(relayPreference ? { relayPreference } : {}),
    });
    await runtime.init();
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = render(() => <VaultSettings runtime={runtime} initialView="relay" onClose={() => undefined} />, root);
    disposers.push(() => {
      dispose();
      root.remove();
    });
    return { root, runtime };
  }

  it('offers no own relay in the web app, whose CSP allows only its built-in relay', async () => {
    const { root, runtime } = await settingsFor();
    expect(runtime.ownRelaySupported).toBe(false);
    expect(root.querySelector('[aria-label="Relay address"]')).toBeNull();
    expect(root.textContent).toContain('Use the desktop app to set your own relay');
    expect(await runtime.setOwnRelay('wss://relay.example/ws')).toBe('An own relay can be set in the desktop app only.');
    await runtime.lock();
  });

  it('lets the desktop app set its own relay, with a warning about the sign-in token', async () => {
    const [url, set] = createSignal<string | null>(null);
    const { root, runtime } = await settingsFor({ url, set });
    expect(runtime.ownRelaySupported).toBe(true);
    expect(root.querySelector('[aria-label="Relay address"]')).not.toBeNull();
    expect(root.textContent).toContain('receives your short-lived Google sign-in token');
    await runtime.lock();
  });


  it('accepts wss:// relays, and ws:// only on this machine', () => {
    expect(parseRelayUrl('')).toEqual({ url: null });
    expect(parseRelayUrl(' wss://relay.example.com/ws/ ')).toEqual({ url: 'wss://relay.example.com/ws' });
    expect(parseRelayUrl('ws://localhost:8787/ws')).toEqual({ url: 'ws://localhost:8787/ws' });
    expect(parseRelayUrl('ws://127.0.0.1:8787/ws')).toEqual({ url: 'ws://127.0.0.1:8787/ws' });
    for (const bad of ['ws://relay.example.com/ws', 'https://relay.example.com', 'wss://u:p@relay.example.com', 'wss://r.example?x=1', 'not a url']) {
      expect(parseRelayUrl(bad)).toHaveProperty('error');
    }
  });

  it('has no relay, in development too, unless VITE_RELAY_URL sets one', () => {
    expect(buildRelayUrl({})).toEqual({});
    expect(buildRelayUrl({ VITE_RELAY_URL: '' })).toEqual({});
    expect(buildRelayUrl({ VITE_RELAY_URL: 'ws://127.0.0.1:8787/ws' })).toEqual({ relayUrl: 'ws://127.0.0.1:8787/ws' });
  });
});
