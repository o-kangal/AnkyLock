import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
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
});
