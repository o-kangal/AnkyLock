import { afterEach, describe, expect, it } from 'vitest';
import type { NoteId } from '@ankylock/core';
import { TEXT_FIELD, createAuthSession } from '@ankylock/sync';
import { guardPageClose } from '../src/runtime/closeGuard.js';
import { createRuntime, type Runtime } from '../src/index.js';
import { FakeDrive, PASSPHRASE, TestVaults, fakeGoogle, localSealer, until } from './helpers.js';

/** Counts uploads of snapshots (PATCH replaces an existing one, POST creates it). */
function countingDrive(): { drive: FakeDrive; uploads: () => number; fail: (on: boolean) => void } {
  const drive = new FakeDrive();
  const inner = drive.fetch;
  let uploads = 0;
  let failing = false;
  Object.defineProperty(drive, 'fetch', {
    value: (async (input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'PATCH' || method === 'POST') {
        if (failing) return new Response('unavailable', { status: 503 });
        uploads++;
      }
      return inner(input, init);
    }) satisfies typeof fetch,
  });
  return { drive, uploads: () => uploads, fail: (on) => void (failing = on) };
}

const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.lock()));
});

async function open(signIn: boolean) {
  const { drive, uploads, fail } = countingDrive();
  const runtime = createRuntime({
    vaults: new TestVaults(),
    sealer: localSealer(),
    auth: createAuthSession(fakeGoogle()),
    relayUrl: 'ws://relay.test/ws',
    // The relay stays unreachable; backups go to Drive regardless.
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
  runtimes.push(runtime);
  await runtime.init();
  expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
  if (signIn) {
    await runtime.signIn();
    await until(() => runtime.syncStatus().backup.kind === 'ok', 'first backup');
  }
  return { runtime, uploads, fail };
}

async function type(runtime: Runtime, text: string): Promise<NoteId> {
  await runtime.store.createTab();
  const noteId = runtime.store.state.tabs.at(-1)?.noteId as NoteId;
  (await runtime.openDoc(noteId)).getText(TEXT_FIELD).insert(0, text);
  return noteId;
}

describe('unbacked changes', () => {
  it('counts edits as unbacked until a backup covers them', async () => {
    const { runtime, uploads } = await open(true);
    expect(runtime.hasUnbackedChanges()).toBe(false);
    await type(runtime, 'draft');
    // Before the debounced save: closing right after typing must still know.
    expect(runtime.hasUnbackedChanges()).toBe(true);

    const before = uploads();
    expect(await runtime.backUpBeforeClose(5_000)).toBe('ok');
    expect(uploads()).toBe(before + 1);
    expect(runtime.hasUnbackedChanges()).toBe(false);
    expect(await runtime.backUpBeforeClose(5_000)).toBe('clean');
    expect(uploads()).toBe(before + 1);
  });

  it('counts hierarchy and settings changes too', async () => {
    const { runtime } = await open(true);
    expect((await runtime.store.createFolder('Inbox', null, null)).ok).toBe(true);
    expect(runtime.hasUnbackedChanges()).toBe(true);
    await runtime.backUpBeforeClose(5_000);
    expect((await runtime.store.changeRetention(14, true)).ok).toBe(true);
    expect(runtime.hasUnbackedChanges()).toBe(true);
    await runtime.backUpBeforeClose(5_000);
    expect(await runtime.renameVault('Work')).toBeNull();
    expect(runtime.hasUnbackedChanges()).toBe(true);
  });

  it('reports a failed backup and keeps the changes unbacked', async () => {
    const { runtime, fail } = await open(true);
    await type(runtime, 'draft');
    fail(true);
    expect(await runtime.backUpBeforeClose(5_000)).toBe('failed');
    expect(runtime.hasUnbackedChanges()).toBe(true);
    fail(false);
  });

  it('has nothing to back up while signed out', async () => {
    const { runtime, uploads } = await open(false);
    await type(runtime, 'local only');
    expect(runtime.hasUnbackedChanges()).toBe(false);
    expect(await runtime.backUpBeforeClose(5_000)).toBe('clean');
    expect(uploads()).toBe(0);
  });

  it('backs up on lock only when something changed', async () => {
    const { runtime, uploads } = await open(true);
    const before = uploads();
    await runtime.lock();
    expect(uploads()).toBe(before);
    expect(await runtime.unlock(runtime.vaults()[0]!.id, PASSPHRASE)).toBeNull();
    await runtime.signIn();
    // A new session backs up once: whatever happened while signed out may not be on Drive.
    await until(() => uploads() === before + 1, 'session backup');
    await type(runtime, 'more');
    await runtime.lock();
    expect(uploads()).toBe(before + 2);
  });
});

describe('page close guard', () => {
  function target() {
    let listener: ((event: BeforeUnloadEvent) => void) | null = null;
    return {
      addEventListener: (_type: string, next: (event: BeforeUnloadEvent) => void) => void (listener = next),
      removeEventListener: () => void (listener = null),
      unload(): boolean {
        const event = new Event('beforeunload', { cancelable: true });
        listener?.(event);
        return event.defaultPrevented;
      },
    };
  }

  it('warns and starts a backup only while changes are unbacked', () => {
    let unbacked = true;
    const started: number[] = [];
    const page = target();
    const guard = guardPageClose(
      { hasUnbackedChanges: () => unbacked, backUpBeforeClose: async (ms) => (started.push(ms), 'ok') },
      page,
    );
    expect(page.unload()).toBe(true);
    expect(started).toHaveLength(1);
    unbacked = false;
    expect(page.unload()).toBe(false);

    unbacked = true;
    guard.release();
    expect(page.unload()).toBe(false);
    guard.dispose();
  });
});
