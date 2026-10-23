import { render } from 'solid-js/web';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { NoteId } from '@ankylock/core';
import { AnkyLockApp, createRuntime, type Runtime } from '../src/index.js';
import { PASSPHRASE, TestVaults, localSealer, until } from './helpers.js';

beforeAll(() => {
  // jsdom has no layout; CodeMirror only needs these to exist.
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null });
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

async function open(narrow: boolean): Promise<{ runtime: Runtime; root: HTMLElement }> {
  const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer() });
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(() => <AnkyLockApp runtime={runtime} platform="web" narrow={() => narrow} />, root);
  await until(() => runtime.status() === 'uninitialized', 'vault list');
  expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
  await until(() => root.querySelector('footer') !== null, 'workspace');
  return { runtime, root };
}

const navigation = (root: HTMLElement): HTMLElement => root.querySelector('[aria-label="Navigation"]') as HTMLElement;
const button = (label: string): HTMLButtonElement =>
  (document.querySelector(`[aria-label="${label}"]`) ?? Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label)) as HTMLButtonElement;

describe('narrow screens', () => {
  it('keeps the sidebar in a drawer that a note choice, the backdrop or Escape closes', async () => {
    const { runtime, root } = await open(true);
    await runtime.store.createTab();
    const noteId = runtime.store.state.tabs[0]?.noteId as NoteId;
    await runtime.store.closeTab(0, false);
    expect(navigation(root).style.visibility).toBe('hidden');

    button('Open navigation').click();
    expect(navigation(root).style.visibility).toBe('visible');
    (root.querySelector('[data-testid="drawer-backdrop"]') as HTMLElement).click();
    expect(navigation(root).style.visibility).toBe('hidden');

    button('Open navigation').click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(navigation(root).style.visibility).toBe('hidden');

    button('Open navigation').click();
    await until(() => root.querySelector(`[data-note-id="${noteId}"]`) !== null, 'note row');
    (root.querySelector(`[data-note-id="${noteId}"]`) as HTMLElement).click();
    await until(() => navigation(root).style.visibility === 'hidden', 'drawer closes on open');
    await runtime.lock();
  });

  it('shortens the status bar and uses touch-sized rows with a row menu button', async () => {
    const { runtime, root } = await open(true);
    const footer = root.querySelector('footer') as HTMLElement;
    expect(footer.textContent).toContain('Local only');
    expect(footer.textContent).not.toContain('Lock');
    expect(root.textContent).toContain('Tap + to open a new scratchpad.');
    expect((root.querySelector('[role="tablist"]') as HTMLElement).style.minHeight).toBe('40px');
    expect(button('Word wrap (Alt+Z)').textContent).toBe('↵');

    await runtime.store.createTab();
    const noteId = runtime.store.state.tabs[0]?.noteId as NoteId;
    await until(() => root.querySelector(`[data-note-id="${noteId}"]`) !== null, 'note row');
    const row = root.querySelector(`[data-note-id="${noteId}"]`) as HTMLElement;
    expect(row.style.height).toBe('40px');
    (row.querySelector('[aria-label^="Actions for"]') as HTMLElement).click();
    await until(() => document.querySelector('[role="menu"]') !== null, 'row menu');
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toContain('Move to…');
    await runtime.lock();
  });

  it('keeps the wide layout on wide screens', async () => {
    const { runtime, root } = await open(false);
    expect(root.querySelector('[aria-label="Open navigation"]')).toBeNull();
    expect(navigation(root)).toBeNull();
    expect(root.querySelector('footer')?.textContent).toContain('Lock');
    await runtime.lock();
  });
});

describe('Move to…', () => {
  it('files a note into a folder and moves folders, skipping invalid destinations', async () => {
    const { runtime, root } = await open(false);
    const { store } = runtime;
    await store.createFolder('Projects', null, null);
    await store.createFolder('Archive box', null, null);
    const projects = store.state.folders.find((f) => f.name === 'Projects')!.id;
    const box = store.state.folders.find((f) => f.name === 'Archive box')!.id;
    await store.createTab();
    const noteId = store.state.tabs[0]?.noteId as NoteId;

    const openMenu = async (selector: string): Promise<string[]> => {
      await until(() => root.querySelector(selector) !== null, selector);
      root.querySelector(selector)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      await until(() => document.querySelector('[role="menu"]') !== null, 'menu');
      button('Move to…').click();
      await until(() => document.querySelector('[aria-label="Destinations"]') !== null, 'destinations');
      return Array.from(document.querySelectorAll('[aria-label="Destinations"] button')).map((b) => b.textContent ?? '');
    };

    expect(await openMenu(`[data-note-id="${noteId}"]`)).toEqual(['Top level (no folder)', 'Archive box', 'Projects']);
    button('Projects').click();
    await until(() => store.state.notes[noteId]?.folderId === projects, 'note filed');

    // A folder is never offered as a destination inside itself.
    expect(await openMenu(`[data-folder-id="${projects}"]`)).toEqual(['Top level (no folder)', 'Archive box']);
    button('Archive box').click();
    await until(() => store.state.folders.find((f) => f.id === projects)?.parentId === box, 'folder moved');
    await runtime.lock();
  });
});
