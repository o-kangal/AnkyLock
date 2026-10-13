Perform a Zero-Knowledge E2EE security audit on the current git diff or specified package: $ARGUMENTS
1. Verify that NO plaintext fields (note title, note body, folder name, category name) are serialized into sync_outbox, WebSocket frames, or server logs.
2. Confirm that every AES-256-GCM encryption call generates a fresh 12-byte cryptographically random IV via crypto.getRandomValues.
3. Verify that Master Encryption Key (MEK) material is never persisted in localStorage, sessionStorage, or plaintext SQLite tables.
4. Output a pass/fail table with exact file:line references for any violation.