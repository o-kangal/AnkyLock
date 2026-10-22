import { t } from '../i18n/index.js';

/** Passwords for protected exports: long enough that guessing them offline is impractical. */
export const MIN_EXPORT_PASSWORD_LENGTH = 8;

/** Work for the export worker: decrypted Yjs states (never sent anywhere) and where they go. */
export interface ExportJob {
  readonly archiveName: string;
  readonly single: boolean;
  readonly dirs: readonly (readonly string[])[];
  readonly items: readonly { readonly dir: readonly string[]; readonly state: Uint8Array | null }[];
  /** Encrypts the zip with WinZip AES-256 when set. */
  readonly password: string | null;
  /** File name for a note without a title, in the user's language. */
  readonly untitled: string;
}

export interface ExportFile {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

/** Runs `buildExport` in a Dedicated Web Worker (AGENTS.md: no heavy work on the main thread). */
export function runExportInWorker(job: ExportJob): Promise<ExportFile> {
  const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
  return new Promise<ExportFile>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<{ ok: true; file: ExportFile } | { ok: false; message: string }>) => {
      if (event.data.ok) resolve(event.data.file);
      else reject(new Error(event.data.message));
    });
    worker.addEventListener('error', (event) => reject(new Error(event.message || t('export.failed'))));
    const buffers = new Set(job.items.flatMap((item) => (item.state ? [item.state.buffer as ArrayBuffer] : [])));
    worker.postMessage(job, [...buffers]);
  }).finally(() => worker.terminate());
}
