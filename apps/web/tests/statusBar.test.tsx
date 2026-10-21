import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpochMs } from '@ankylock/core';
import { SyncStatusBar } from '../src/components/SyncStatusBar.jsx';
import { tokens } from '../src/components/sidebar/styles.js';
import type { Runtime, SyncStatus } from '../src/runtime/createRuntime.js';

const SIGNED_IN: SyncStatus = {
  auth: 'signed-in',
  connection: 'open',
  backup: { kind: 'ok', at: Date.UTC(2026, 9, 21, 14, 5) as EpochMs },
  catchingUp: false,
  vaultDrive: 'ok',
  onDrive: true,
};

/** Just what the status bar reads from a runtime; the status is driven by the test. */
function fakeRuntime() {
  const [status, setStatus] = createSignal<SyncStatus>(SIGNED_IN);
  const runtime = {
    syncStatus: status,
    vaultName: () => 'Personal',
    lock: vi.fn(async () => undefined),
    signIn: vi.fn(async () => null),
    signOut: vi.fn(async () => undefined),
    syncNow: vi.fn(async () => undefined),
    keepLocalOnly: vi.fn(async () => undefined),
  } as unknown as Runtime;
  return { runtime, setStatus };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

function mount(runtime: Runtime, wrapOn = false): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  const [on, setOn] = createSignal(wrapOn);
  const dispose = render(
    () => (
      <SyncStatusBar
        runtime={runtime}
        wordWrap={{ on, toggle: () => setOn(!on()), shortcut: 'Alt+Z' }}
        theme={{ choice: () => 'dark', scheme: () => 'dark', choose: () => undefined, cycle: () => undefined }}
      />
    ),
    root,
  );
  disposers.push(() => {
    dispose();
    root.remove();
  });
  return root;
}

const button = (root: HTMLElement, text: string): HTMLButtonElement =>
  Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

describe('status bar', () => {
  it('draws every action as a button, with plain states as text', () => {
    const { runtime } = fakeRuntime();
    const root = mount(runtime);
    for (const text of ['Personal', 'Lock', 'Sign out', 'Wrap (Alt+Z)', 'Dark']) {
      const b = button(root, text);
      expect(b.style.borderRadius).toBe(tokens.radiusControl);
      expect(b.style.textDecoration).toBe('');
      expect(b.style.height).toBe('30px');
    }
    expect(root.querySelector('[aria-label="Sync now"]')).not.toBeNull();
    expect(root.textContent).toContain('Synced');
    expect(root.textContent).not.toMatch(/[|·]/);
  });

  it('highlights a button under the mouse, but not on touch', () => {
    const root = mount(fakeRuntime().runtime);
    const lock = button(root, 'Lock');
    const resting = lock.style.background;
    lock.dispatchEvent(Object.assign(new MouseEvent('pointerenter'), { pointerType: 'touch' }));
    expect(lock.style.background).toBe(resting);
    lock.dispatchEvent(Object.assign(new MouseEvent('pointerenter'), { pointerType: 'mouse' }));
    expect(lock.style.background).toBe(tokens.buttonHoverBackground);
    lock.dispatchEvent(new MouseEvent('pointerleave'));
    expect(lock.style.background).toBe(resting);
  });

  it('shows Word wrap pressed while it is on', () => {
    const root = mount(fakeRuntime().runtime, true);
    const wrap = button(root, 'Wrap (Alt+Z)');
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    expect(wrap.style.borderColor).toBe(tokens.accent);
    wrap.click();
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
    expect(wrap.style.borderColor).toBe(tokens.fieldBorder);
  });

  it('keeps Wrap, Theme and Sync now in place while sync runs', () => {
    const { runtime, setStatus } = fakeRuntime();
    const root = mount(runtime);
    const right = (): Element[] => Array.from(root.querySelector('footer > span:last-child')?.children ?? []);
    const before = right();
    const label = root.querySelector('[data-backup-label]') as HTMLElement;
    const visible = (): string => label.lastElementChild?.textContent ?? '';
    // The box is as wide as its longest regular text, whatever it shows.
    const sizes = Array.from(label.querySelectorAll('[aria-hidden="true"]')).map((s) => s.textContent);
    expect(sizes).toEqual(['Backed up 12:00 PM', 'Backing up…', 'Syncing…']);
    expect(visible()).toMatch(/^Backed up \d\d:\d\d [AP]M$/);

    setStatus({ ...SIGNED_IN, catchingUp: true });
    expect(visible()).toBe('Syncing…');
    const sync = root.querySelector('[aria-label="Sync now"]') as HTMLButtonElement;
    expect([sync.disabled, sync.getAttribute('aria-busy')]).toEqual([true, 'true']);
    // The same elements, in the same order: nothing was swapped in or out.
    expect(right()).toEqual(before);

    setStatus(SIGNED_IN);
    expect(right()).toEqual(before);
    expect(sync.disabled).toBe(false);
  });

  it('cuts a long backup error with an ellipsis and keeps it whole in the tooltip', () => {
    const { runtime, setStatus } = fakeRuntime();
    const root = mount(runtime);
    setStatus({ ...SIGNED_IN, backup: { kind: 'error', reason: 'conflict', at: 0 as EpochMs } });
    const label = root.querySelector('[data-backup-label]') as HTMLElement;
    expect(label.title).toBe('Google Drive holds a different vault with this id; backup stopped');
    expect(label.style.maxWidth).toBe('320px');
    expect((label.lastElementChild as HTMLElement).style.textOverflow).toBe('ellipsis');
  });
});

describe('status bar without sync', () => {
  it('leaves no empty label box when signed out and never backed up', () => {
    const { runtime, setStatus } = fakeRuntime();
    const root = mount(runtime);
    setStatus({ ...SIGNED_IN, auth: 'signed-out', connection: 'off', backup: { kind: 'never' } });
    expect(root.querySelector('[data-backup-label]')).toBeNull();
    expect(root.querySelector('[aria-label="Sync now"]')).toBeNull();
    expect(button(root, 'Sign in with Google')).toBeDefined();
  });
});
