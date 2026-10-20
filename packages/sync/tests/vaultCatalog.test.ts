import { describe, expect, it } from 'vitest';
import type { EpochMs, VaultId } from '@ankylock/core';
import { DriveError, deleteAllFromDrive, vaultHeaderFileName, vaultSnapshotFileName, type DriveFile } from '../src/index.js';

const VAULT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as VaultId;
const VAULT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as VaultId;
const DEVICE_1 = '11111111-1111-4111-8111-111111111111';
const DEVICE_2 = '22222222-2222-4222-8222-222222222222';

/** appDataFolder by name; `failDeletes` makes that many deletions fail, `onDelete` runs after each. */
class StubDrive {
  readonly names = new Set<string>();
  readonly deleted: string[] = [];
  failDeletes = 0;
  onDelete: (name: string) => void = () => undefined;

  constructor(names: readonly string[]) {
    for (const name of names) this.names.add(name);
  }

  async listFiles(prefix: string): Promise<DriveFile[]> {
    return [...this.names].filter((n) => n.startsWith(prefix)).map((name) => ({ id: name, name, modifiedTime: 0 as EpochMs }));
  }

  async deleteFile(id: string): Promise<void> {
    if (this.failDeletes > 0) {
      this.failDeletes--;
      throw new DriveError('network', null, 'offline');
    }
    if (!this.names.delete(id)) throw new DriveError('http', 404, 'not found');
    this.deleted.push(id);
    this.onDelete(id);
  }
}

const allFiles = [
  vaultSnapshotFileName(VAULT_A, DEVICE_1),
  vaultSnapshotFileName(VAULT_A, DEVICE_2),
  vaultHeaderFileName(VAULT_A),
  vaultSnapshotFileName(VAULT_B, DEVICE_1),
  vaultHeaderFileName(VAULT_B),
  'ankylock-snapshot.v1.bin',
];

describe('deleteAllFromDrive', () => {
  it('deletes every vault, device backup and legacy file, headers first', async () => {
    const drive = new StubDrive(allFiles);
    expect(await deleteAllFromDrive(drive)).toEqual({ remaining: 0 });
    expect(drive.names.size).toBe(0);
    expect(drive.deleted.slice(0, 2).sort()).toEqual([vaultHeaderFileName(VAULT_A), vaultHeaderFileName(VAULT_B)]);
  });

  it('reports what remains after a failure, and a retry deletes the rest', async () => {
    const drive = new StubDrive(allFiles);
    drive.onDelete = () => {
      if (drive.deleted.length === 3) drive.failDeletes = 1;
    };
    expect(await deleteAllFromDrive(drive)).toEqual({ remaining: 3 });
    expect(await deleteAllFromDrive(drive)).toEqual({ remaining: 0 });
  });

  it('counts a backup another device uploads meanwhile, and treats files deleted elsewhere as gone', async () => {
    const drive = new StubDrive(allFiles);
    const late = vaultSnapshotFileName(VAULT_B, DEVICE_2);
    drive.onDelete = (name) => {
      if (name === vaultHeaderFileName(VAULT_B)) {
        drive.names.delete(vaultSnapshotFileName(VAULT_B, DEVICE_1));
        drive.names.add(late);
      }
    };
    expect(await deleteAllFromDrive(drive)).toEqual({ remaining: 1 });
    expect([...drive.names]).toEqual([late]);
  });

  it('fails when Drive cannot even be listed', async () => {
    const drive = new StubDrive(allFiles);
    drive.listFiles = () => Promise.reject(new DriveError('network', null, 'offline'));
    await expect(deleteAllFromDrive(drive)).rejects.toThrow('offline');
  });
});
