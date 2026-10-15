import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultId } from '@ankylock/core';
import { createAuthSession, type SocketLike } from '@ankylock/sync';
import { VaultSettings } from '../src/components/VaultSettings.jsx';
import { createRuntime, type Runtime } from '../src/index.js';
import { FakeDrive, PASSPHRASE, TestVaults, fakeGoogle, localSealer, until } from './helpers.js';

/** The relay plays no part here: everything goes through Google Drive. */
const unreachableRelay = (): SocketLike => ({
  binaryType: 'blob',
  readyState: 0,
  onopen: null,
  onclose: null,
  onmessage: null,
  onerror: null,
  send: () => undefined,
  close: () => undefined,
});

function device(drive: FakeDrive): { runtime: Runtime; vaults: TestVaults } {
  const vaults = new TestVaults();
  const runtime = createRuntime({
    vaults,
    sealer: localSealer(),
    auth: createAuthSession(fakeGoogle()),
    relayUrl: 'ws://relay.test/ws',
    createSocket: unreachableRelay,
    driveFetch: drive.fetch,
  });
  return { runtime, vaults };
}

const vaultFiles = (drive: FakeDrive, id: VaultId): string[] => drive.names().filter((n) => n.startsWith(`vault-${id}.`));

/** Device A creates and backs up a vault; device B opens it from Drive. */
async function sharedVault(drive: FakeDrive) {
  const a = device(drive);
  await a.runtime.init();
  expect(await a.runtime.createVault('Personal', PASSPHRASE)).toBeNull();
  await a.runtime.signIn();
  await until(() => a.runtime.syncStatus().backup.kind === 'ok', 'A backed up');
  const id = a.runtime.vaults()[0]?.id as VaultId;

  const b = device(drive);
  await b.runtime.init();
  const found = await b.runtime.findRemoteVaults();
  expect('vaults' in found && found.vaults.map((v) => v.vaultId)).toEqual([id]);
  expect(await b.runtime.openRemoteVault(id, PASSPHRASE)).toBeNull();
  await until(() => b.runtime.syncStatus().backup.kind === 'ok', 'B backed up');
  return { a, b, id };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

describe('vault management', () => {
  it('renames a vault; other devices take the newer name on their next sync', async () => {
    const { a, b, id } = await sharedVault(new FakeDrive());
    expect(await a.runtime.renameVault('  ')).toBe('Give the vault a name.');
    expect(await a.runtime.renameVault('Work')).toBeNull();
    expect(a.runtime.vaultName()).toBe('Work');

    await b.runtime.syncNow();
    expect(b.runtime.vaultName()).toBe('Work');
    await b.runtime.lock();
    expect(await b.runtime.unlock(id, PASSPHRASE)).toBeNull();
    expect(b.runtime.vaultName()).toBe('Work');
    await Promise.all([a.runtime.lock(), b.runtime.lock()]);
  });

  it('removes a vault from this device and keeps its Drive copy', async () => {
    const drive = new FakeDrive();
    const { a, b, id } = await sharedVault(drive);
    expect(await a.runtime.removeVault({ everywhere: false })).toBeNull();
    expect(a.runtime.status()).toBe('uninitialized');
    expect(await a.vaults.list()).toEqual([]);
    expect(vaultFiles(drive, id)).toContain(`vault-${id}.header.json`);

    const found = await a.runtime.findRemoteVaults();
    expect('vaults' in found && found.vaults.map((v) => v.vaultId)).toEqual([id]);
    await b.runtime.lock();
  });

  it('deletes a vault everywhere; other devices stop syncing and may keep a local copy', async () => {
    const drive = new FakeDrive();
    const { a, b, id } = await sharedVault(drive);
    expect(await a.runtime.removeVault({ everywhere: true })).toBeNull();
    expect(vaultFiles(drive, id)).toEqual([]);

    // B notices instead of uploading the vault again.
    await b.runtime.syncNow();
    expect(b.runtime.syncStatus()).toMatchObject({ vaultDrive: 'deleted', connection: 'off', onDrive: false });
    expect(vaultFiles(drive, id)).toEqual([]);

    await b.runtime.keepLocalOnly();
    await b.runtime.lock();
    expect(await b.runtime.unlock(id, PASSPHRASE)).toBeNull();
    expect(b.runtime.syncStatus()).toMatchObject({ vaultDrive: 'local-only', connection: 'off' });

    await b.runtime.backUpAgain();
    await until(() => b.runtime.syncStatus().backup.kind === 'ok', 'backed up again');
    expect(vaultFiles(drive, id)).toContain(`vault-${id}.header.json`);
    await b.runtime.lock();
  });

  it('cleans up the Drive files from before vaults had ids', async () => {
    const drive = new FakeDrive();
    for (const name of ['ankylock-snapshot.v1.bin', 'ankylock-vault-header.v1.json']) {
      drive.files.set(name, { name, data: new Uint8Array([1]), modifiedTime: Date.now() });
    }
    const { a, b } = await sharedVault(drive);
    expect(drive.names().filter((n) => n.startsWith('ankylock-'))).toEqual([]);
    await Promise.all([a.runtime.lock(), b.runtime.lock()]);
  });
});

describe('VaultSettings', () => {
  function mount(runtime: Runtime, view: 'menu' | 'remove' | 'delete' = 'menu'): HTMLElement {
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = render(() => <VaultSettings runtime={runtime} initialView={view} onClose={() => undefined} />, root);
    disposers.push(() => {
      dispose();
      root.remove();
    });
    return root;
  }
  const type = (root: HTMLElement, label: string, value: string): void => {
    const input = root.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  const button = (root: HTMLElement, text: string): HTMLButtonElement =>
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement;

  it('asks for the vault name before deleting everywhere', async () => {
    const { a, b } = await sharedVault(new FakeDrive());
    const root = mount(a.runtime, 'delete');
    expect(root.textContent).toContain('cannot be undone');
    expect(button(root, 'Delete everywhere').disabled).toBe(true);
    type(root, 'Type the vault name to confirm', 'Personal');
    expect(button(root, 'Delete everywhere').disabled).toBe(false);
    await Promise.all([a.runtime.lock(), b.runtime.lock()]);
  });

  it('removes a backed-up vault without typing, but warns when it has no Drive copy', async () => {
    const { a, b } = await sharedVault(new FakeDrive());
    const backedUp = mount(a.runtime, 'remove');
    expect(backedUp.textContent).toContain('The copy in Google Drive stays');
    expect(button(backedUp, 'Remove from this device').disabled).toBe(false);
    await a.runtime.keepLocalOnly();
    const localOnly = mount(a.runtime, 'remove');
    expect(localOnly.textContent).toContain('deletes its notes for good');
    expect(button(localOnly, 'Remove from this device').disabled).toBe(true);
    await Promise.all([a.runtime.lock(), b.runtime.lock()]);
  });

  it('renames from the menu', async () => {
    const { a, b } = await sharedVault(new FakeDrive());
    const root = mount(a.runtime);
    type(root, 'Vault name', 'Research');
    root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => a.runtime.vaultName() === 'Research', 'renamed');
    await Promise.all([a.runtime.lock(), b.runtime.lock()]);
  });
});
