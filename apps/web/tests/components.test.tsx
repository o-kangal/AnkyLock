import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoteId } from '@ankylock/core';
import { Sidebar, TabBar, VirtualList } from '../src/index.js';
import { setup } from './helpers.js';

let dispose: (() => void) | undefined;
let root: HTMLDivElement;

function mount(view: () => ReturnType<typeof VirtualList>): void {
  root = document.createElement('div');
  document.body.append(root);
  dispose = render(view, root);
}

afterEach(() => {
  dispose?.();
  root?.remove();
});

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe('VirtualList', () => {
  it('renders only the visible window of a large list', () => {
    const items = Array.from({ length: 5000 }, (_, i) => `row ${i}`);
    mount(() => (
      <VirtualList items={items} rowHeight={24} overscan={2} fallbackHeight={240}>
        {(item: string) => <span>{item}</span>}
      </VirtualList>
    ));
    const rendered = root.querySelectorAll('[role="listitem"]');
    expect(rendered.length).toBe(12); // 10 visible + 2 overscan below
    expect(rendered[0]?.textContent).toBe('row 0');
  });
});

describe('Sidebar', () => {
  it('renders the immutable system categories and the workspace tree', async () => {
    const { store } = setup();
    await store.createFolder('Inbox', null, null);
    mount(() => <Sidebar store={store} />);
    expect(root.textContent).toContain('All Notes');
    expect(root.textContent).toContain('Archive');
    expect(root.textContent).toContain('Trash');
    expect(root.querySelector('[data-folder-id="id-1"]')?.textContent).toContain('Inbox');
  });

  it('switches to the Trash view', async () => {
    const { store } = setup();
    await store.createTab();
    await store.trashNote('id-1' as NoteId);
    mount(() => <Sidebar store={store} />);
    expect(root.querySelector('[data-note-id="id-1"]')).toBeNull();
    (Array.from(root.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Trash') as HTMLElement).click();
    expect(root.querySelector('[data-note-id="id-1"]')).not.toBeNull();
  });
});

describe('TabBar', () => {
  it('opens new Untitled tabs and discards empty ones on close', async () => {
    const { store, storage } = setup();
    mount(() => <TabBar store={store} isEmptyAndUnmodified={() => true} />);
    (root.querySelector('[aria-label="New tab"]') as HTMLButtonElement).click();
    await waitFor(() => root.querySelector('[role="tab"]') !== null, 'new tab');
    expect(root.querySelector('[role="tab"]')?.textContent).toContain('Untitled-1');
    expect(root.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true');

    (root.querySelector('[aria-label="Close tab"]') as HTMLButtonElement).click();
    await waitFor(async () => (await storage.getNote('id-1' as NoteId)) === null, 'note discarded');
    expect(root.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });
});
