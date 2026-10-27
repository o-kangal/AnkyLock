// The site's English text: the source of every key. `{name}` marks a parameter.
export const en = {
  'meta.description':
    'AnkyLock is a local-first, end-to-end encrypted scratchpad and notes app for developers. Notes are encrypted on your device; nobody else can read them.',
  'meta.downloadTitle': 'Download AnkyLock',
  'meta.downloadDescription': 'Download AnkyLock for Linux as an AppImage, .deb or .rpm package, with SHA-256 checksums.',

  'nav.skip': 'Skip to content',
  'nav.back': 'Home',
  'nav.home': 'AnkyLock home',
  'nav.download': 'Download',
  'nav.github': 'GitHub',
  'nav.openApp': 'Go to AnkyLock',
  'nav.main': 'Main',

  'logo.toggle': 'Lock or unlock the logo',

  'hero.title': 'Notes only you can read.',
  'hero.lead':
    'AnkyLock is a local-first, end-to-end encrypted scratchpad and notes app for developers. Your notes are encrypted on your device, with a key only your passphrase can produce.',
  'hero.download': 'Download',
  'hero.github': 'View on GitHub',
  'hero.note': 'Free and open source. No account with us, no tracking.',

  'features.title': 'What it does',
  'features.scratchpad.title': 'A scratchpad that saves itself',
  'features.scratchpad.text': 'Open a tab and type. Every tab saves as you write, and its first line becomes the title.',
  'features.organize.title': 'Folders, categories, Archive and Trash',
  'features.organize.text': 'Folders up to three levels deep, your own categories, and a Trash that empties itself after 28 days.',
  'features.sync.title': 'Sync through your own Google Drive',
  'features.sync.text':
    'Each vault is backed up, encrypted, to a private app folder in your Drive. Your other devices merge it within minutes, and edits made on two devices at once both survive.',
  'features.offline.title': 'Works offline',
  'features.offline.text': 'Everything lives on your device first. Sync and backup run in the background and never block typing.',
  'features.vaults.title': 'Separate vaults',
  'features.vaults.text': 'Keep work and personal notes apart, each vault with its own passphrase and key.',
  'features.export.title': 'Your notes, your files',
  'features.export.text': 'Export a note, a folder or a whole vault as plain text at any time, optionally in an AES-256 protected zip.',
  'features.editor.title': 'Made for code and quick notes',
  'features.editor.text': 'A code editor in JetBrains Mono with Tab indenting, word wrap and clickable links. Light and dark themes, in English and Turkish.',
  'features.screenshot': 'The AnkyLock workspace in the dark theme: folders on the left, a note open in the editor.',

  'how.title': 'How it works',
  'how.lead': 'The encryption happens on your device, before anything is saved or sent.',
  'how.passphrase.title': 'Your passphrase',
  'how.passphrase.text': 'You choose it when you create a vault. It is never stored and never sent anywhere.',
  'how.key.title': 'Your key',
  'how.key.text':
    'At every unlock, your device derives the vault key from the passphrase (PBKDF2-SHA-256, 600,000 iterations). The key lives only in memory.',
  'how.encrypt.title': 'Encrypted on your device',
  'how.encrypt.text': 'Notes, titles and folder names are encrypted with AES-256-GCM before they are saved or leave the device.',
  'how.drive.title': 'Google Drive holds only ciphertext',
  'how.drive.text': 'Your Drive stores encrypted files it cannot read. A new device opens them only with your passphrase.',

  'promise.title': 'What AnkyLock promises',
  'promise.nobody': 'Nobody but you can read your notes: not Google, not a relay, not us.',
  'promise.key': 'Your key never leaves your device and is never derived from your Google account.',
  'promise.tracking': 'No account with us, no analytics, no ads, no trackers.',
  'promise.open': 'Everything that touches your data is open source, under the AGPL-3.0.',
  'limits.title': 'What it does not do',
  'limits.recovery':
    'It cannot recover a forgotten passphrase. There is no reset link, by design: without the passphrase, the notes stay locked.',
  'limits.device': 'It cannot protect an unlocked device from malware, or your notes from someone who knows your passphrase.',
  'limits.metadata': 'It hides what your notes say, not that they exist: Google sees the size and timing of your encrypted backups.',
  'limits.more': 'Read the threat model and the security review',

  'open.title': 'Open source',
  'open.text': 'AnkyLock is free software under the GNU AGPL-3.0. Read the code, build it yourself, or report a security issue privately.',
  'open.source': 'Source code',
  'open.threatModel': 'Threat model',
  'open.review': 'Security review',
  'open.report': 'Report a vulnerability',

  'download.title': 'Download AnkyLock',
  'download.lead': 'The desktop app for Linux. Prefer the browser? AnkyLock also runs on the web, with nothing to install.',
  'download.version': 'Version {version}, released on {date}.',
  'download.none': 'The first release is on its way. Until then, use the web app or build AnkyLock from source.',
  'download.buildFromSource': 'Build from source',
  'download.button': 'Download',
  'download.file': 'Download {file}',
  'download.checksum': 'SHA-256',
  'download.appimage.text': 'Runs on most distributions without installing, and updates itself.',
  'download.deb.text': 'For Debian, Ubuntu, Linux Mint and other Debian-based distributions.',
  'download.rpm.text': 'For Fedora, openSUSE and other RPM-based distributions.',
  'download.install': 'Install',
  'download.install.appimage': 'Make the AppImage executable, then run it:',
  'download.install.deb': 'Install the package with apt:',
  'download.install.rpm': 'Install the package with dnf (or zypper on openSUSE):',
  'download.verify.title': 'Check your download',
  'download.verify.text':
    'Compare the file’s SHA-256 checksum with the one shown above, or let the GitHub CLI check that GitHub Actions built the file from this repository:',
  'download.other.title': 'Windows and macOS',
  'download.other.text': 'Coming later. Until then, you can build them from source; the README explains how.',

  'notFound.title': 'Page not found',
  'notFound.text': 'There is nothing at this address. It may have moved, or the link may be mistyped.',
  'notFound.home': 'Go to the home page',

  'footer.privacy': 'Privacy',
  'footer.terms': 'Terms',
  'footer.license': 'AGPL-3.0',
  'footer.englishOnly': '(in English)',
  'footer.language': 'Language',
  'footer.theme': 'Theme',

  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = { readonly [K in MessageKey]: string };
