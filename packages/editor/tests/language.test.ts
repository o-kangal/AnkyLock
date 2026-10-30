import { language } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { TEXT_FIELD, setNoteName } from '@ankylock/sync';
import { detectLanguage, editorBasics, noteLanguage, yjsBinding } from '../src/index.js';

beforeAll(() => {
  // jsdom has no layout; CodeMirror only needs these to exist.
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null });
});

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
});

const detected = (name: string | null, firstLine = ''): string | null => detectLanguage(name, firstLine)?.name ?? null;

describe('detectLanguage', () => {
  it('reads the extension or file name of the note name', () => {
    expect(detected('deploy.sh')).toBe('Shell');
    expect(detected('App.tsx')).toBe('TSX');
    expect(detected('README.MD')).toBe('Markdown');
    expect(detected('Dockerfile')).toBe('Dockerfile');
    expect(detected('.env.local')).toBe('Properties files');
    expect(detected('.zshrc')).toBe('Shell');
  });

  it('reads a shebang when the name has no known extension', () => {
    expect(detected(null, '#!/bin/bash')).toBe('Shell');
    expect(detected(null, '#!/usr/bin/env python3.12')).toBe('Python');
    expect(detected(null, '#!/usr/bin/env -S node --no-warnings')).toBe('JavaScript');
    expect(detected(null, '#!/usr/bin/env deno')).toBe('TypeScript');
    expect(detected('backup', '#!/bin/sh')).toBe('Shell');
    // An explicit name wins over the shebang.
    expect(detected('tool.py', '#!/bin/bash')).toBe('Python');
  });

  it('takes line 1 as a file name only when the note has no name and it has no spaces', () => {
    expect(detected(null, 'docker-compose.yaml')).toBe('YAML');
    expect(detected(null, 'const a = b.c')).toBeNull();
    expect(detected('Notes', 'config.json')).toBeNull();
  });

  it('leaves everything else as plain text', () => {
    expect(detected(null, 'Shopping list')).toBeNull();
    expect(detected('Meeting notes', '')).toBeNull();
    expect(detected(null, '#!')).toBeNull();
  });

  it('stays fast on hostile line 1 text', () => {
    const started = performance.now();
    expect(detected(null, `#${'!'.repeat(50_000)}`)).toBeNull();
    expect(detected(null, `#!/usr/bin/env x${'.'.repeat(50_000)}`)).toBeNull();
    expect(detected(null, `${'.'.repeat(50_000)}x`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('noteLanguage', () => {
  function editor(text: string, name: string | null): { view: EditorView; doc: Y.Doc } {
    const doc = new Y.Doc();
    doc.getText(TEXT_FIELD).insert(0, text);
    if (name !== null) setNoteName(doc, name);
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: text, extensions: [editorBasics, yjsBinding(doc), noteLanguage(doc)] }),
    });
    views.push(view);
    return { view, doc };
  }
  const languageOf = (view: EditorView): string | null => view.state.facet(language)?.name ?? null;

  it('loads the language of the note name, and follows a rename', async () => {
    const { view, doc } = editor('{"a": 1}', 'data.json');
    await vi.waitFor(() => expect(languageOf(view)).toBe('json'));
    setNoteName(doc, 'data.py');
    await vi.waitFor(() => expect(languageOf(view)).toBe('python'));
    setNoteName(doc, '');
    await vi.waitFor(() => expect(languageOf(view)).toBeNull());
  });

  it('follows a shebang typed on line 1', async () => {
    const { view } = editor('echo hi', null);
    expect(languageOf(view)).toBeNull();
    view.dispatch({ changes: { from: 0, insert: '#!/bin/sh\n' } });
    await vi.waitFor(() => expect(languageOf(view)).toBe('shell'));
  });
});
