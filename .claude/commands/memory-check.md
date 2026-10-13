Audit Solid.js components and CodeMirror 6 / Yjs lifecycle in: $ARGUMENTS
1. Ensure only the active tab mounts an EditorView DOM instance; inactive tabs must unmount their DOM nodes cleanly via Solid onCleanup().
2. Check that all Y.Doc update listeners (doc.on('update', ...)) and WebSocket event handlers are explicitly unregistered on component disposal.
3. Verify no large plaintext strings or unvirtualized lists (>50 items) are held in reactive Solid signals.