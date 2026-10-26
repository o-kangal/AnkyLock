# Changelog

All notable changes to AnkyLock. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). A release's notes on GitHub are its section here; a version is released once its heading carries a date instead of `Unreleased`.

## [0.1.0] - Unreleased

The first public release: the desktop app for Linux (AppImage, .deb, .rpm) and the web app at app.ankylock.com.

### Added

- Vaults encrypted on the device with AES-256-GCM, under a key derived from the vault's passphrase (PBKDF2-SHA-256, 600,000 iterations) that is never stored or sent.
- A scratchpad that saves itself: new tabs are notes, and line 1 becomes the title.
- Folders up to three levels deep, categories, Archive, and a Trash that empties itself after 28 days (configurable).
- Sync and backup through the user's own Google Drive (the app's hidden folder only), merging edits from several devices through Yjs; an optional relay of one's own for instant sync on the desktop.
- Export of a note, a folder or a vault as plain text, optionally in an AES-256 protected zip; deleting a vault, or all of AnkyLock's data, from Google Drive.
- A CodeMirror editor with Tab indenting, word wrap and clickable links; light, dark and system themes; English and Turkish.
- Updates for the AppImage, signed and installed only after the user agrees.
