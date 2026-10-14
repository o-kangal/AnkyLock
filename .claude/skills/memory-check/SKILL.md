---
name: memory-check
description: Memory and lifecycle rules for AnkyLock's Solid.js UI, CodeMirror 6 editor and Yjs documents — mount only the active tab's EditorView, keep background tabs as headless Y.Doc, clean up every listener with onCleanup, virtualize lists over 50 items, keep large plaintext out of signals. Use it when building or reviewing packages/editor, tab bar, sidebar/folder tree, workspaceStore, or anything that subscribes to Y.Doc/WebSocket events, and when the user asks for a memory/leak/lifecycle audit (/memory-check <target>).
argument-hint: "[component, package, or path]"
---

# UI Memory & Lifecycle

Users keep 100+ scratchpad tabs open. If each kept a CodeMirror DOM tree, a Yjs observer and a socket handler alive, the WebView would grow without bound. On desktop the WebView is WebKitGTK, WebView2 or WKWebView, and there are no Chrome DevTools to catch the leak. The rules below keep cost proportional to *visible* work.

## Part 1: Building

### Editor (packages/editor)

- **Exactly one `EditorView` at a time.** It belongs to the focused tab. Switching tabs destroys the old view (`view.destroy()`) and creates a new one bound to the new tab's `Y.Text`. Background tabs exist only as `Y.Doc` instances held by the sync `docManager`.
- Don't hide inactive editors with CSS: `display: none` still keeps the DOM and all its listeners.
- The `y-codemirror.next` binding (`yCollab`) belongs to the view, not to the doc. It is torn down with the view. The `Y.Doc` itself must outlive the view.
- Undo history: use `Y.UndoManager` scoped to the tab's `Y.Text` and owned by the doc layer, so undo survives tab switches without keeping the view alive.
- Derive titles (first 40 chars of line 1) from a cheap `Y.Text` observer or the CM update listener, read only up to the first newline. Don't call `toString()` on the whole document on every keystroke.

### Solid components

- Every `doc.on('update', fn)`, `ytext.observe(fn)`, `socket.addEventListener`, `window.addEventListener`, `setInterval`, `ResizeObserver` and worker `onmessage` registered in a component gets a matching removal in `onCleanup()`. Register and clean up next to each other so a reviewer can see the pair.
- Effects that create resources (`createEffect` that builds an `EditorView`) dispose the previous resource at the top of the effect or in `onCleanup` *inside* the effect. Otherwise a re-run leaks the previous instance.
- Don't keep note bodies or other large plaintext strings in signals or stores. Signals hold ids, titles and flags. Content lives in `Y.Doc`. A store containing 100 × 1 MB strings is 100 MB of reactive tracking.
- Plaintext must not be cached in reactive state after a note is closed. This is also a zero-knowledge concern: less plaintext in memory means less exposure.

### Lists

- The sidebar note and folder lists and any list that can exceed **50 items** are virtualized. Render only the rows in the viewport plus a small overscan. Use a headless Solid virtualizer such as `@tanstack/solid-virtual`, or a small hand-written windowing primitive. Don't use a component library (AGENTS.md).
- Drag-and-drop across a virtualized tree must work on ids, not DOM nodes, because the drop target row may not be mounted yet.

### Floating UI

Menus, popovers and dialogs use the shared `Popover` component (`apps/web/src/components/Popover.tsx`), which renders in a Solid `Portal` on `<body>` with `position: fixed`. WebKit (WKWebView on macOS, WebKitGTK on Linux) composites `overflow: auto` scroll containers on their own layer and paints them over absolutely positioned descendants of sibling elements, whatever their `z-index`. jsdom does no layout, so unit tests can't catch this. Check what's on top with `document.elementFromPoint` in a real engine.

**Checking in a real engine without opening a window (Linux):** serve the page (`vite preview`), then load it from Python with `gi` into a `WebKit2.WebView` (4.1) inside a `Gtk.OffscreenWindow`. Set `WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1` (offscreen has no GL), and run probes with `call_async_javascript_function`. To stop the server for an offline test, kill the PID that `ss -ltnp` shows listening on the port. `pkill -f <pattern>` also matches the shell command that contains the pattern and kills it.

### Cross-realm values

Never type-check bytes with `instanceof Uint8Array` / `instanceof ArrayBuffer`. Values from IndexedDB, `postMessage`, WebSocket frames or test environments can come from another realm, where `instanceof` is false and data gets dropped silently. Use `Object.prototype.toString.call(v) === '[object Uint8Array]'` (or `'[object ArrayBuffer]'`). This has bitten twice: in the storage guard (Task 9) and in the relay client (Task 11c).

### Styling

There are no global CSS files and no component libraries (AGENTS.md). That also rules out Tailwind, which needs a global CSS entry file. Use component-scoped styles (CSS modules or inline style objects) together with a small set of shared design tokens.

## Part 2: Auditing

Target: `$ARGUMENTS` (ask if it's empty and there's no obvious recent change).

For each component or module in scope:

1. Count `EditorView` constructions and their `destroy()` calls. Prove that only the active tab can hold one: follow the condition that guards mounting.
2. List every subscription (see the list above) and match each to its removal. Note any subscription created inside an effect that can re-run.
3. Check signals and stores for large strings, unbounded arrays (caches, history) and `Y.Doc` references for closed tabs that are never released.
4. Check that lists which can exceed 50 items are virtualized.
5. Check that heavy work (encrypt, decode, diffing, syntax detection) is not done on the main thread inside a reactive computation.

### Report format

```
## Memory Check — <target>

| # | Check | Result | Location | Detail |
|---|-------|--------|----------|--------|
| 1 | Single EditorView for active tab only | PASS/FAIL/N/A | file:line | ... |
| 2 | All Y.Doc / WS / DOM listeners released in onCleanup | ... |
| 3 | No large plaintext / unbounded data in signals | ... |
| 4 | Lists >50 items virtualized | ... |
| 5 | No heavy work on main thread in reactive code | ... |

### Leaks
<per FAIL: file:line, what is retained and when, concrete fix>
```
