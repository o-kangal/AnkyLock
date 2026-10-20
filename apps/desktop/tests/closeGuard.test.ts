import { describe, expect, it } from 'vitest';
import { guardWindowClose, type CloseState, type ClosableWindow } from '../src/closeGuard.js';

type Result = 'clean' | 'ok' | 'failed' | 'timeout';

function fakeWindow() {
  let handler: ((event: { preventDefault(): void }) => Promise<void>) | null = null;
  const win = {
    destroyed: false,
    async onCloseRequested(next: (event: { preventDefault(): void }) => Promise<void>) {
      handler = next;
      return () => void (handler = null);
    },
    async destroy() {
      win.destroyed = true;
    },
    /** What Tauri does: run the handler, then destroy unless it prevented closing. */
    async requestClose() {
      let prevented = false;
      await handler?.({ preventDefault: () => void (prevented = true) });
      if (!prevented) await win.destroy();
    },
  };
  return win satisfies ClosableWindow & { requestClose(): Promise<void> };
}

function setup(result: Result, unbacked = true) {
  const win = fakeWindow();
  const states: CloseState[] = [];
  const waits: number[] = [];
  const runtime = {
    hasUnbackedChanges: () => unbacked,
    backUpBeforeClose: async (waitMs: number) => {
      waits.push(waitMs);
      return result;
    },
  };
  const guard = guardWindowClose(win, runtime, (state) => states.push(state), 10_000);
  return { win, states, waits, guard };
}

describe('desktop close guard', () => {
  it('backs up, then closes', async () => {
    const { win, states, waits } = setup('ok');
    await win.requestClose();
    expect(waits).toEqual([10_000]);
    expect(states).toEqual(['backing-up']);
    expect(win.destroyed).toBe(true);
  });

  it('closes at once when nothing needs a backup, after saving pending edits', async () => {
    const { win, states, waits } = setup('clean', false);
    await win.requestClose();
    expect(waits).toHaveLength(1);
    expect(states).toEqual([]);
    expect(win.destroyed).toBe(true);
  });

  it.each(['failed', 'timeout'] as const)('stays open and asks when the backup %s', async (result) => {
    const { win, states, guard } = setup(result);
    await win.requestClose();
    expect(win.destroyed).toBe(false);
    expect(states).toEqual(['backing-up', 'unbacked']);

    guard.stay();
    expect(states.at(-1)).toBe('open');
    expect(win.destroyed).toBe(false);

    await guard.quit();
    expect(win.destroyed).toBe(true);
  });

  it('does not back up again when quitting anyway', async () => {
    const { win, waits, guard } = setup('failed');
    await win.requestClose();
    await guard.quit();
    await win.requestClose();
    expect(waits).toHaveLength(1);
  });
});
