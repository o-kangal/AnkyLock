import { EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { editorTheme } from '../src/index.js';

describe('editor theme', () => {
  it('writes notes in JetBrains Mono at 14 px, line height 1.6, without ligatures', () => {
    const view = new EditorView({ parent: document.body, state: EditorState.create({ extensions: editorTheme('dark') }) });
    const scroller = getComputedStyle(view.scrollDOM);
    expect(scroller.fontFamily).toContain('JetBrains Mono Variable');
    expect(scroller.fontFamily).toContain('monospace');
    expect(scroller.lineHeight).toBe('1.6');
    expect(scroller.getPropertyValue('font-variant-ligatures')).toBe('none');
    expect(getComputedStyle(view.dom).fontSize).toBe('14px');
    view.destroy();
  });

  it('keeps the active line translucent, so a selection within it stays visible', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const view = new EditorView({
        parent: document.body,
        state: EditorState.create({ doc: 'one line', extensions: [editorTheme(scheme), highlightActiveLine()] }),
      });
      const band = getComputedStyle(view.dom.querySelector('.cm-activeLine') as Element).backgroundColor;
      const alpha = Number(/rgba\(.*,\s*([\d.]+)\)/.exec(band)?.[1] ?? '1');
      expect(alpha, `${scheme}: ${band}`).toBeLessThan(0.2);
      view.destroy();
    }
  });
});
