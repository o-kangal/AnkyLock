import { buildExport } from './buildExport.js';
import type { ExportJob } from './exportNotes.js';

// The shared tsconfig types `self` as Window; inside a worker it is the worker's global scope.
const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<ExportJob>) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

/** Export worker: turns decrypted note states into the file to save. It sends nothing anywhere. */
scope.addEventListener('message', (event) => {
  buildExport(event.data).then(
    (file) => scope.postMessage({ ok: true, file }, [file.bytes.buffer as ArrayBuffer]),
    (error: unknown) => scope.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) }, []),
  );
});
