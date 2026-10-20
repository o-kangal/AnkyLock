// Runs inside the export worker (and tests); the main bundle never loads zip.js.
import { TextReader, Uint8ArrayWriter, ZipWriter, configure } from '@zip.js/zip.js';
import * as Y from 'yjs';
import { TEXT_FIELD } from '@ankylock/sync';
import type { ExportFile, ExportJob } from './exportNotes.js';
import { noteFileName, uniqueName } from './exportPlan.js';

// The worker already runs off the main thread; zip.js must not start workers of its own.
configure({ useWebWorkers: false });

const textOf = (state: Uint8Array | null): string => {
  if (state === null) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getText(TEXT_FIELD).toString();
  doc.destroy();
  return text;
};

/**
 * Builds the export file: one plain-text note, or a zip with the directory structure. Protected
 * zips use AES-256 (encryption strength 3), never the broken legacy ZipCrypto. Entry names
 * inside a zip stay readable: the format does not encrypt them.
 */
export async function buildExport(job: ExportJob): Promise<ExportFile> {
  const taken = new Map<string, Set<string>>();
  const files = job.items.map((item) => {
    const text = textOf(item.state);
    const key = item.dir.join('/');
    const names = taken.get(key) ?? new Set<string>();
    taken.set(key, names);
    return { path: [...item.dir, uniqueName(names, noteFileName(text))].join('/'), text };
  });

  const [first] = files;
  if (job.single && first && job.password === null) {
    return { name: first.path, type: 'text/plain;charset=utf-8', bytes: new TextEncoder().encode(first.text) };
  }

  const writer = new ZipWriter(
    new Uint8ArrayWriter(),
    job.password === null ? {} : { password: job.password, encryptionStrength: 3, zipCrypto: false },
  );
  for (const dir of job.dirs) await writer.add(`${dir.join('/')}/`, undefined, { directory: true });
  for (const file of files) await writer.add(file.path, new TextReader(file.text));
  const name = job.single && first ? first.path.replace(/\.[^.]*$/, '') : job.archiveName;
  return { name: `${name}.zip`, type: 'application/zip', bytes: await writer.close() };
}

