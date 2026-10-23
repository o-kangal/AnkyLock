# GitHub Repository Settings

The settings of `o-kangal/AnkyLock` that the code relies on, and how to apply them with the GitHub CLI (`R=repos/o-kangal/AnkyLock`). Settings marked *public* are only available once the repository is public (or on GitHub Pro).

## Applied

| Setting | Value | Command |
|---|---|---|
| Default `GITHUB_TOKEN` permissions | read-only, cannot approve PRs | `gh api -X PUT $R/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false` |
| Allowed actions | GitHub-owned plus the list in `selected-actions` below | `gh api -X PUT $R/actions/permissions -F enabled=true -f allowed_actions=selected -F sha_pinning_required=false` |
| Selected actions | `pnpm/action-setup`, `dtolnay/rust-toolchain`, `Swatinem/rust-cache`, `EmbarkStudios/cargo-deny-action` | `gh api -X PUT $R/actions/permissions/selected-actions --input -` with `{"github_owned_allowed":true,"verified_allowed":false,"patterns_allowed":["pnpm/action-setup@*","dtolnay/rust-toolchain@*","Swatinem/rust-cache@*","EmbarkStudios/cargo-deny-action@*"]}` |
| Dependabot alerts and security updates | on | `gh api -X PUT $R/vulnerability-alerts && gh api -X PUT $R/automated-security-fixes` |

A workflow that needs a new third-party action fails until the action is added to the selected list.

Leave **SHA pinning required** off: it also applies to the workflows GitHub runs for Dependabot, which call actions by tag, so with it on Dependabot silently stops (no runs, no rebases). Our own workflows pin every action to a commit SHA anyway, and Dependabot keeps those pins current.

## Once the repository is public

| Setting | Command |
|---|---|
| Ruleset for `main`: no deletion, no force-push, linear history, signed commits | `gh api -X POST $R/rulesets --input .github/rulesets/main.json` |
| Ruleset for `v*` tags: no deletion, no moving, signed | `gh api -X POST $R/rulesets --input .github/rulesets/release-tags.json` |
| Private vulnerability reporting (`SECURITY.md` points to it) | `gh api -X PUT $R/private-vulnerability-reporting` |
| Secret scanning and push protection | `gh api -X PATCH $R --input -` with `{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}` |
| Workflow runs from first-time and external contributors need approval | `gh api -X PUT $R/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors` |

CodeQL (`.github/workflows/codeql.yml`) skips its analysis while the repository is private and starts by itself once it is public; leave CodeQL's "default setup" off, since it conflicts with the workflow.

## Commit signing

Commits and release tags are signed with SSH keys (`git config gpg.format ssh`, `commit.gpgsign true`, `tag.gpgsign true`). The `main` ruleset rejects unsigned commits, so add your public key on GitHub as a **signing key** (Settings → SSH and GPG keys), or with `gh ssh-key add ~/.ssh/id_ed25519.pub --type signing`.
