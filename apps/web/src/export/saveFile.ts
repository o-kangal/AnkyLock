import { createContext, useContext } from 'solid-js';
import type { ExportFile } from './exportNotes.js';
import type { ExportScope } from './exportPlan.js';

/** Saves an exported file; resolves false when the user cancelled. */
export type SaveFile = (file: ExportFile) => Promise<boolean>;

/** Web: a regular download. The file is built in memory and never uploaded. */
export const downloadFile: SaveFile = async (file) => {
  const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  // Revoked later: some browsers start reading the blob after `click` returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
};

/** Desktop overrides it with the native save dialog. */
export const SaveFileContext = createContext<SaveFile>(downloadFile);
export const useSaveFile = (): SaveFile => useContext(SaveFileContext);

/** Opens the export dialog for a note, a folder or the vault; provided by the workspace. */
export type OpenExport = (scope: ExportScope, label: string) => void;
export const ExportContext = createContext<OpenExport>();
export const useExport = (): OpenExport | undefined => useContext(ExportContext);
