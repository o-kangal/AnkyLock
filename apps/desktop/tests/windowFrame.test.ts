import { describe, expect, it, vi } from 'vitest';
import baseConfig from '../src-tauri/tauri.conf.json';
import linuxConfig from '../src-tauri/tauri.linux.conf.json';
import { drawsWindowCorners, frameStyle, watchWindowFill, type FrameWindow } from '../src/windowFrame.js';

describe('window frame', () => {
  it('makes only the Linux window transparent, otherwise the same window', () => {
    // Platform files replace the whole `windows` list, so they must not drift apart.
    const [base] = baseConfig.app.windows;
    const [linux] = linuxConfig.app.windows;
    expect(base && 'transparent' in base).toBe(false);
    expect(linux).toEqual({ ...base, transparent: true });
  });

  it('draws its own corners on Linux only', () => {
    expect(drawsWindowCorners('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15')).toBe(true);
    expect(drawsWindowCorners('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140')).toBe(false);
    expect(drawsWindowCorners('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15')).toBe(false);
  });

  it('rounds the frame while floating, and fills the screen when maximized', () => {
    const theme = { background: 'var(--bg)', border: 'var(--border)', radiusPanel: '12px' } as const;
    expect(frameStyle(theme, true, false)).toMatchObject({ 'border-radius': '12px', border: '1px solid var(--border)', overflow: 'hidden' });
    expect(frameStyle(theme, true, true)).toMatchObject({ 'border-radius': '0', border: 'none' });
    expect(frameStyle(theme, false, false)).toMatchObject({ 'border-radius': '0', border: 'none' });
  });

  it('follows maximize and fullscreen on every resize until stopped', async () => {
    let maximized = false;
    let fullscreen = false;
    let resized: () => void = () => undefined;
    const unlisten = vi.fn();
    const window: FrameWindow = {
      isMaximized: async () => maximized,
      isFullscreen: async () => fullscreen,
      onResized: async (handler) => {
        resized = handler;
        return unlisten;
      },
    };
    const seen: boolean[] = [];
    const stop = watchWindowFill(window, (filled) => seen.push(filled));
    await vi.waitFor(() => expect(seen).toEqual([false]));
    maximized = true;
    resized();
    await vi.waitFor(() => expect(seen).toEqual([false, true]));
    maximized = false;
    fullscreen = true;
    resized();
    await vi.waitFor(() => expect(seen).toEqual([false, true, true]));
    stop();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    resized();
    await Promise.resolve();
    expect(seen).toHaveLength(3);
  });
});
