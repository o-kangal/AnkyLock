import { createEffect, createSignal, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import type * as Y from 'yjs';
import type { NoteId } from '@ankylock/core';
import { CodeMirrorView, type ColorScheme } from '@ankylock/editor';
import { shortcutLabel, workspaceCommand, type Platform } from '../keyboard/shortcuts.js';
import { createWordWrapPreference } from '../preferences/devicePreferences.js';
import type { Runtime } from '../runtime/createRuntime.js';
import { Sidebar } from './sidebar/Sidebar.jsx';
import { SyncStatusBar } from './SyncStatusBar.jsx';
import { tokens } from './sidebar/styles.js';
import { TabBar } from './tabs/TabBar.jsx';

/** Follows the OS light/dark preference; falls back to light where matchMedia is unavailable. */
function useColorScheme(): () => ColorScheme {
  const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const [scheme, setScheme] = createSignal<ColorScheme>(query?.matches ? 'dark' : 'light');
  if (query) {
    const onChange = (event: MediaQueryListEvent): void => {
      setScheme(event.matches ? 'dark' : 'light');
    };
    query.addEventListener('change', onChange);
    onCleanup(() => query.removeEventListener('change', onChange));
  }
  return scheme;
}

/**
 * Main layout: sidebar, tab bar and a single editor for the active tab. Background tabs keep
 * only their headless Y.Doc in the runtime; closing a tab closes its doc.
 */
export function Workspace(props: { readonly runtime: Runtime; readonly platform: Platform }): JSX.Element {
  const { store } = props.runtime;
  const scheme = useColorScheme();
  const wrap = createWordWrapPreference();
  const activeId = (): NoteId | undefined => store.state.tabs[store.state.activeTabIndex]?.noteId;
  const [doc, setDoc] = createSignal<{ readonly id: NoteId; readonly doc: Y.Doc } | null>(null);

  createEffect(
    on(activeId, (id) => {
      if (id === undefined) {
        setDoc(null);
        return;
      }
      let current = true;
      onCleanup(() => {
        current = false;
      });
      void props.runtime.openDoc(id).then((opened) => {
        if (current) setDoc({ id, doc: opened });
      });
    }),
  );

  // Docs follow tabs: a closed or purged tab releases its doc after saving pending edits.
  createEffect(on(() => store.state.tabs.map((t) => t.noteId), (ids) => void props.runtime.retainDocs(ids)));

  const closeTab = (index: number): void => {
    const tab = store.state.tabs[index];
    if (tab) void store.closeTab(index, props.runtime.isEmptyAndUnmodified(tab.noteId));
  };

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = workspaceCommand(event, props.platform);
      const { tabs, activeTabIndex } = store.state;
      if (command === 'toggle-wrap') wrap.toggle();
      else if (command === 'new-tab') void store.createTab();
      else if (command === 'close-tab' && activeTabIndex >= 0) closeTab(activeTabIndex);
      else if ((command === 'next-tab' || command === 'previous-tab') && tabs.length > 0) {
        store.activateTab((activeTabIndex + (command === 'previous-tab' ? tabs.length - 1 : 1)) % tabs.length);
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%', font: tokens.font }}>
      {/* The single row takes exactly the space above the status bar; content scrolls inside it. */}
      <div
        style={{
          display: 'grid',
          'grid-template-columns': '260px minmax(0, 1fr)',
          'grid-template-rows': 'minmax(0, 1fr)',
          flex: '1',
          'min-height': '0',
        }}
      >
        <Sidebar store={store} />
        <section style={{ display: 'flex', 'flex-direction': 'column', 'min-width': '0' }}>
          <TabBar store={store} isEmptyAndUnmodified={(id) => props.runtime.isEmptyAndUnmodified(id)} />
          <div style={{ flex: '1', 'min-height': '0' }}>
            <Show
              when={doc()}
              fallback={
                <div style={{ display: 'grid', 'place-items': 'center', height: '100%', color: tokens.muted }}>
                  Press {shortcutLabel('new-tab', props.platform)} to open a new scratchpad.
                </div>
              }
            >
              {(open) => (
                <CodeMirrorView
                  doc={open().doc}
                  active={true}
                  autoFocus={true}
                  readOnly={store.state.notes[open().id]?.deletedAt != null}
                  colorScheme={scheme()}
                  wordWrap={wrap.wordWrap()}
                  onTitleChange={(title) => store.setTitle(open().id, title)}
                />
              )}
            </Show>
          </div>
        </section>
      </div>
      <SyncStatusBar
        runtime={props.runtime}
        wordWrap={{ on: wrap.wordWrap, toggle: wrap.toggle, shortcut: shortcutLabel('toggle-wrap', props.platform) }}
      />
    </div>
  );
}
