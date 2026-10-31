# Changelog

All notable changes to AnkyLock. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). A release's notes on GitHub are its section here; a version is released once its heading carries a date instead of `Unreleased`.

## [0.2.0] - 2026-10-31

### Added

- Syntax highlighting for more than 140 languages, chosen from the note's name (`deploy.sh`, `Dockerfile`) or a shebang on line 1, and available offline. Ctrl+/ comments lines in the note's language.
- Find and replace in the open note (Ctrl+F), with case, regular expression and whole-word matching; Ctrl+D selects the next match and Ctrl+Alt+G goes to a line. On phones and tablets, a search button in the tab bar opens it.
- Multiple cursors: Alt+drag selects a column and edits every line at once, and Ctrl+click adds a cursor.
- Notes can be renamed. The name replaces line 1 as the title and names the exported file; clearing it brings line 1 back. Names are encrypted and synced like the text.
- The sidebar sorts by last change, creation date or name, in either direction, remembered per device.
- A guide to every keyboard shortcut (F1, or the keyboard button in the status bar).
- The web app offers to install itself on phones and tablets.

### Fixed

- A selection within the cursor's line was invisible in the dark theme.
- After opening a vault from Google Drive on a new device, a note renamed or retitled on another device could show its old title until it was opened.

### Security

- Updated seroval, a dependency of Solid, for GHSA-f86p-h4j2-7qgj and GHSA-9wx9-5pv9-3349.

## [0.1.1] - 2026-10-28

### Fixed

- The Linux AppImage opens the browser again for Google sign-in and for links in notes. Before, the browser could fail to start, so "Use my existing vault" waited until sign-in timed out.
- Google sign-in on the web app ends on an AnkyLock page instead of a bare redirect, which Chrome had flagged as deceptive.

## [0.1.0] - 2026-10-27

The first public release: the desktop app for Linux (AppImage, .deb, .rpm) and the web app at app.ankylock.com.

### Added

- Vaults encrypted on the device with AES-256-GCM, under a key derived from the vault's passphrase (PBKDF2-SHA-256, 600,000 iterations) that is never stored or sent.
- A scratchpad that saves itself: new tabs are notes, and line 1 becomes the title.
- Folders up to three levels deep, categories, Archive, and a Trash that empties itself after 28 days (configurable).
- Sync and backup through the user's own Google Drive (the app's hidden folder only), merging edits from several devices through Yjs; an optional relay of one's own for instant sync on the desktop.
- Export of a note, a folder or a vault as plain text, optionally in an AES-256 protected zip; deleting a vault, or all of AnkyLock's data, from Google Drive.
- A CodeMirror editor with Tab indenting, word wrap and clickable links; light, dark and system themes; English and Turkish.
- Updates for the AppImage, signed and installed only after the user agrees.
