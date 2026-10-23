# Security Policy

AnkyLock's purpose is to keep notes readable only by their owner, so security reports are welcome and handled first.

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)). Do not open a public issue or pull request for a vulnerability before it is fixed.

Include what you found, how to reproduce it, the version or commit, and the impact you see. You will get an acknowledgement within 7 days and a first assessment within 14 days. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Scope

In scope: anything that breaks the promises in the [threat model](docs/security/threat-model.md), for example

- note content, titles or names readable by anyone without the vault passphrase (Google Drive, a relay, the network, the disk of a locked device);
- weaknesses in the encryption, key derivation or key handling;
- a relay or Drive file that can change, move or delete a user's data undetected;
- script injection into the app, or a way around its content security policy;
- the desktop host doing more than its IPC commands allow (files, links, other processes);
- leaks of Google tokens, or access beyond the `drive.appdata` scope.

Out of scope: attacks that need an unlocked device under the attacker's control or the vault passphrase, denial of service through a relay you run yourself, issues in dependencies without an effect on AnkyLock (report those upstream), and missing hardening without a concrete attack.

## Supported versions

Until 1.0, only the latest release (and `main`) receives security fixes.

## For maintainers

The checks that run on every change, the threat model and past reviews are in [`docs/security/`](docs/security/). Dependency audits: `pnpm audit`, `cargo audit`, `cargo deny check`; secret scanning: `gitleaks git --config .gitleaks.toml`.
