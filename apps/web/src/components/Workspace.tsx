import { createEffect, createSignal, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import type * as Y from 'yjs';
import type { NoteId } from '@ankylock/core';
import { CodeMirrorView } from '@ankylock/editor';
import { linkModifier, shortcutLabel, workspaceCommand, type Platform } from '../keyboard/shortcuts.js';
import { useNarrowScreen } from '../layout/screen.js';
import { createWordWrapPreference } from '../preferences/devicePreferences.js';
import type { Runtime } from '../runtime/createRuntime.js';
import { useTheme } from '../theme/colorScheme.js';
import { Sidebar } from './sidebar/Sidebar.jsx';
import { SyncStatusBar } from './SyncStatusBar.jsx';
import { tokens } from './sidebar/styles.js';
import { TabBar } from './tabs/TabBar.jsx';

/**
 * Main layout: sidebar, tab bar and a single editor for the active tab. Background tabs keep
 * only their headless Y.Doc in the runtime; closing a tab closes its doc.
 */
/** Web default: a new tab that cannot reach back into AnkyLock (`noopener`) or learn where it came from. */
export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function Workspace(props: {
  readonly runtime: Runtime;
  readonly platform: Platform;
  /** Opens an http(s) link from a note; the desktop app hands it to the system browser. */
  readonly openLink?: (url: string) => void;
}): JSX.Element {
  const { store } = props.runtime;
  const theme = useTheme();
  const wrap = createWordWrapPreference();
  const narrow = useNarrowScreen();
  /** On narrow screens the sidebar is a drawer over the editor. */
  const [drawer, setDrawer] = createSignal(false);
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
      if (event.key === 'Escape' && drawer()) {
        setDrawer(false);
        return;
      }
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

  // Opening a note is what the drawer is for; it also closes when the screen widens.
  createEffect(on(activeId, () => setDrawer(false), { defer: true }));
  createEffect(on(narrow, (isNarrow) => !isNarrow && setDrawer(false), { defer: true }));

  /** The sidebar stays mounted (its tree keeps its state); on narrow screens it slides in and out. */
  const sidebarStyle = (): JSX.CSSProperties =>
    narrow()
      ? {
          position: 'absolute',
          top: '0',
          bottom: '0',
          left: '0',
          width: 'min(85%, 320px)',
          'z-index': '2',
          background: tokens.surface,
          'box-shadow': drawer() ? `2px 0 12px ${tokens.shadow}` : 'none',
          transform: drawer() ? 'none' : 'translateX(-100%)',
          visibility: drawer() ? 'visible' : 'hidden',
          transition: 'transform 160ms ease-out, visibility 160ms',
        }
      : { 'min-width': '0' };

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%', font: tokens.font }}>
      {/* The single row takes exactly the space above the status bar; content scrolls inside it. */}
      <div
        style={{
          position: 'relative',
          display: 'grid',
          'grid-template-columns': narrow() ? 'minmax(0, 1fr)' : '260px minmax(0, 1fr)',
          'grid-template-rows': 'minmax(0, 1fr)',
          flex: '1',
          'min-height': '0',
        }}
      >
        <div role={narrow() ? 'dialog' : undefined} aria-label={narrow() ? 'Navigation' : undefined} style={sidebarStyle()}>
          <Sidebar store={store} />
        </div>
        <Show when={narrow() && drawer()}>
          <div
            data-testid="drawer-backdrop"
            aria-hidden="true"
            style={{ position: 'absolute', inset: '0', 'z-index': '1', background: tokens.overlay }}
            onClick={() => setDrawer(false)}
          />
        </Show>
        <section style={{ display: 'flex', 'flex-direction': 'column', 'min-width': '0' }}>
          <TabBar
            store={store}
            isEmptyAndUnmodified={(id) => props.runtime.isEmptyAndUnmodified(id)}
            compact={narrow()}
            {...(narrow() ? { onOpenNavigation: () => setDrawer(true) } : {})}
          />
          <div style={{ flex: '1', 'min-height': '0' }}>
            <Show
              when={doc()}
              fallback={
                <div style={{ display: 'grid', 'place-items': 'center', height: '100%', color: tokens.muted }}>
                  {narrow()
                    ? 'Tap + to open a new scratchpad.'
                    : `Press ${shortcutLabel('new-tab', props.platform)} to open a new scratchpad.`}
                </div>
              }
            >
              {(open) => (
                <CodeMirrorView
                  doc={open().doc}
                  active={true}
                  autoFocus={true}
                  readOnly={store.state.notes[open().id]?.deletedAt != null}
                  colorScheme={theme.scheme()}
                  wordWrap={wrap.wordWrap()}
                  fontSize={narrow() ? 16 : 13}
                  links={{ modifier: linkModifier(), open: (url) => (props.openLink ?? openInNewTab)(url) }}
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
        theme={theme}
        compact={narrow()}
      />
    </div>
  );
}
