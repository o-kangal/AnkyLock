import { deriveTitle, type FolderId, type NoteId } from '@ankylock/core';
import type { WorkspaceState } from '../stores/workspaceStore.js';

export type ExportScope =
  | { readonly kind: 'note'; readonly id: NoteId }
  | { readonly kind: 'folder'; readonly id: FolderId }
  | { readonly kind: 'vault' };

export interface ExportItem {
  /** Directories inside the archive, already safe and unique. */
  readonly dir: readonly string[];
  readonly noteId: NoteId;
}

export interface ExportPlan {
  /** Base name of the zip (no extension); a single unprotected note is named after its title instead. */
  readonly archiveName: string;
  readonly items: readonly ExportItem[];
  /** Every directory to create, so empty folders and categories keep the structure. */
  readonly dirs: readonly (readonly string[])[];
  readonly single: boolean;
}

// Characters Windows, macOS or Linux reject in file names, plus control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
// Windows reserves these names whatever their extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME = 100;

/** A file or directory name every OS accepts: reserved characters become `_`, reserved names get a `_` prefix. */
export function safeName(name: string, fallback = 'Untitled'): string {
  let safe = name.normalize('NFC').replace(UNSAFE, '_').trim();
  const chars = [...safe];
  if (chars.length > MAX_NAME) safe = chars.slice(0, MAX_NAME).join('');
  // Windows drops trailing dots and spaces, which would make two names collide.
  safe = safe.replace(/[. ]+$/, '');
  if (safe === '') safe = fallback;
  return RESERVED.test(safe) ? `_${safe}` : safe;
}

const splitExtension = (name: string): readonly [string, string] => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
};

/**
 * Picks `name`, or `name (2)`, `name (3)`… before the extension, unused in `taken` (compared
 * case-insensitively: Windows and macOS file systems are), and records it.
 */
export function uniqueName(taken: Set<string>, name: string): string {
  const [stem, extension] = splitExtension(name);
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${extension}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

// A title that already ends in an extension (`README.md`, `config.yaml`) keeps it.
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Names for things without one, in the user's language. Passed in rather than translated here:
 * this module also runs in the export worker.
 */
export interface ExportNames {
  readonly untitled: string;
  readonly untitledFolder: string;
  readonly folder: string;
  readonly vault: string;
}

export const ENGLISH_EXPORT_NAMES: ExportNames = { untitled: 'Untitled', untitledFolder: 'Untitled folder', folder: 'Folder', vault: 'vault' };

/** The file name of a note: its title (line 1, BR-NOTE-03), with `.txt` unless it has an extension. */
export function noteFileName(text: string, untitled = ENGLISH_EXPORT_NAMES.untitled): string {
  const firstLine = text.slice(0, 400).split('\n', 1)[0] ?? '';
  const title = safeName(deriveTitle(firstLine) ?? untitled, untitled);
  return HAS_EXTENSION.test(title) ? title : `${title}.txt`;
}

/**
 * What to export, from the decrypted workspace: live notes (archived ones included, Trash left out)
 * placed in directories for their category and folder path. Runs on the main thread; it only
 * walks names already in memory.
 */
export function planExport(
  state: Pick<WorkspaceState, 'categories' | 'folders' | 'notes'>,
  scope: ExportScope,
  vaultName: string | null,
  date: string,
  names: ExportNames = ENGLISH_EXPORT_NAMES,
): ExportPlan {
  const folders = new Map(state.folders.filter((f) => f.deletedAt === null).map((f) => [f.id, f]));
  const notes = Object.values(state.notes).filter((n) => n.deletedAt === null);

  if (scope.kind === 'note') {
    const note = state.notes[scope.id];
    if (!note || note.deletedAt !== null) throw new Error('Notes in Trash are not exported.');
    return { archiveName: '', items: [{ dir: [], noteId: note.id }], dirs: [], single: true };
  }

  // Unique directory names among siblings, keyed by the parent directory.
  const taken = new Map<string, Set<string>>();
  const child = (parent: readonly string[], name: string): string[] => {
    const key = parent.join('/');
    const siblings = taken.get(key) ?? new Set<string>();
    taken.set(key, siblings);
    return [...parent, uniqueName(siblings, safeName(name, names.untitledFolder))];
  };

  const root = scope.kind === 'folder' ? folders.get(scope.id) : undefined;
  if (scope.kind === 'folder' && !root) throw new Error('Folders in Trash are not exported.');

  const categoryDirs = new Map<string, string[]>();
  if (scope.kind === 'vault') for (const category of state.categories) categoryDirs.set(category.id, child([], category.name));

  const folderDirs = new Map<FolderId, string[]>();
  const dirOf = (id: FolderId): string[] | null => {
    const known = folderDirs.get(id);
    if (known) return known;
    const folder = folders.get(id);
    if (!folder) return null;
    let parent: string[] | null;
    if (root && folder.id === root.id) parent = [];
    else if (folder.parentId !== null) parent = dirOf(folder.parentId);
    else if (root) parent = null; // Outside the exported folder.
    else parent = folder.categoryId !== null ? (categoryDirs.get(folder.categoryId) ?? []) : [];
    if (parent === null) return null;
    const dir = child(parent, folder.name);
    folderDirs.set(id, dir);
    return dir;
  };
  for (const folder of folders.values()) dirOf(folder.id);

  const items: ExportItem[] = [];
  for (const note of notes) {
    let dir: readonly string[] | null;
    if (note.folderId !== null) dir = dirOf(note.folderId);
    else if (root) dir = null;
    else dir = note.categoryId !== null ? (categoryDirs.get(note.categoryId) ?? []) : [];
    if (dir !== null) items.push({ dir, noteId: note.id });
  }

  return {
    archiveName: root ? safeName(root.name, names.folder) : safeName(`AnkyLock ${vaultName ?? names.vault} ${date}`, names.untitled),
    items,
    dirs: [...categoryDirs.values(), ...folderDirs.values()],
    single: false,
  };
}
