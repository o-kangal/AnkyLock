import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { t, type PendingUpdate } from '@ankylock/web/workspace';

/** The parts of the updater and process plugins used here; fakeable in tests. */
export interface UpdaterApi {
  check(): Promise<{ readonly version: string; downloadAndInstall(): Promise<void> } | null>;
  relaunch(): Promise<void>;
}

const tauriUpdater: UpdaterApi = { check, relaunch };

/**
 * Asks GitHub's latest release for a newer AppImage. The host registers the updater only when
 * running as an AppImage, so for .deb and .rpm installs, offline starts and an unreachable
 * GitHub this finds nothing. Installing saves open notes first, verifies the download against
 * the public key in tauri.conf.json (the plugin refuses an unsigned or altered file), replaces
 * the AppImage and restarts.
 */
export async function findDesktopUpdate(saveNotes: () => Promise<void>, updater: UpdaterApi = tauriUpdater): Promise<PendingUpdate | null> {
  let update: Awaited<ReturnType<UpdaterApi['check']>>;
  try {
    update = await updater.check();
  } catch (error) {
    console.info('No update check', error);
    return null;
  }
  if (!update) return null;
  const found = update;
  return {
    message: t('update.availableVersion', { version: found.version }),
    action: t('update.install'),
    busy: t('update.installing'),
    apply: async () => {
      await saveNotes();
      await found.downloadAndInstall();
      await updater.relaunch();
    },
  };
}
