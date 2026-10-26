import { describe, expect, it, vi } from 'vitest';
import { findDesktopUpdate, type UpdaterApi } from '../src/updates.js';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));

function fakeUpdater(found: string | null | Error, steps: string[] = []): UpdaterApi {
  return {
    check: async () => {
      if (found instanceof Error) throw found;
      return found === null ? null : { version: found, downloadAndInstall: async () => void steps.push('install') };
    },
    relaunch: async () => void steps.push('relaunch'),
  };
}

describe('desktop updates', () => {
  it('offers a newer version, and installing saves notes, installs, then restarts', async () => {
    const steps: string[] = [];
    const update = await findDesktopUpdate(async () => void steps.push('save'), fakeUpdater('0.2.0', steps));
    expect(update?.message).toBe('AnkyLock 0.2.0 is available.');
    expect(update?.action).toBe('Install and restart');
    await update?.apply();
    expect(steps).toEqual(['save', 'install', 'relaunch']);
  });

  it('offers nothing when there is no newer version', async () => {
    expect(await findDesktopUpdate(async () => undefined, fakeUpdater(null))).toBeNull();
  });

  it('stays quiet when updates are unavailable (a .deb or .rpm install, offline, GitHub unreachable)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(await findDesktopUpdate(async () => undefined, fakeUpdater(new Error('plugin updater not found')))).toBeNull();
  });

  it('does not restart when the install fails, so the banner can say so', async () => {
    const steps: string[] = [];
    const failing: UpdaterApi = {
      check: async () => ({ version: '0.2.0', downloadAndInstall: () => Promise.reject(new Error('signature mismatch')) }),
      relaunch: async () => void steps.push('relaunch'),
    };
    const update = await findDesktopUpdate(async () => void steps.push('save'), failing);
    await expect(update?.apply()).rejects.toThrow('signature mismatch');
    expect(steps).toEqual(['save']);
  });
});
