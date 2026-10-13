import type { Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { TEXT_FIELD } from '@ankylock/sync';

/**
 * One undo history per note text, owned by the doc layer rather than the view, so undo/redo
 * survives tab switches while the EditorView itself is destroyed. Weakly held: it goes away
 * with the `Y.Text` (Y.UndoManager also destroys itself when its doc is destroyed).
 */
const undoManagers = new WeakMap<Y.Text, Y.UndoManager>();

export function undoManagerFor(text: Y.Text): Y.UndoManager {
  let manager = undoManagers.get(text);
  if (!manager) {
    // Tracks local edits only; remote and loaded updates use REMOTE_ORIGIN and are not undoable.
    manager = new Y.UndoManager(text);
    undoManagers.set(text, manager);
  }
  return manager;
}

export function noteText(doc: Y.Doc): Y.Text {
  return doc.getText(TEXT_FIELD);
}

/**
 * Binds the editor to the note's `Y.Text`. The binding belongs to the view and is torn down
 * with it; the `Y.Doc` outlives the view. No awareness: remote cursors are out of MVP scope.
 */
export function yjsBinding(doc: Y.Doc): Extension {
  const text = noteText(doc);
  return [yCollab(text, null, { undoManager: undoManagerFor(text) }), keymap.of(yUndoManagerKeymap)];
}
