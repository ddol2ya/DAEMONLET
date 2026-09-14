# GitHub publication settings

These files prepare repository protections; committing them does not apply a ruleset or change visibility. Keep the repository private until the user explicitly authorizes public conversion. Check the actual settings before applying anything.

## Settings that can be applied while private

- Allow merge commits; disable squash/rebase merging and auto-merge.
- Keep automatic branch deletion disabled.
- Keep Actions default workflow permissions read-only and disable workflow approval of pull requests. The CI workflow also declares `contents: read`.
- Pin every external action to its full commit SHA. The current pins preserve the existing action major versions.
- Allow GitHub-owned actions only; require full-SHA pinning after the pinned workflow is on main. Review future changes to the allowlist deliberately.
- Keep Issues and Discussions enabled and Wiki disabled. Public discussions and issue templates must not invite users to paste credentials or full private Codex transcripts.

## Apply after an authorized public conversion

The private repository's current plan does not expose branch rulesets or the public-fork approval policy. Prepare them now and apply them immediately after conversion; use a plan supporting private rulesets if protection must be enforced before conversion.

1. Confirm the intended repository and its actual visibility. Save its existing rulesets and avoid creating duplicate names.
2. Apply [main.ruleset.json](../.github/main.ruleset.json) through the repository ruleset API or UI. It requires a PR, resolved review threads and the `verify` and `windows` checks from GitHub Actions; branches must be up to date. It blocks main deletion and force pushes. Zero mandatory approving reviews accommodates a single maintainer; add a reviewer requirement when another maintainer is available. Do not enable linear-history enforcement while using merge commits.
3. Apply [version-tags.ruleset.json](../.github/version-tags.ruleset.json). It permits new version tags but blocks updates/deletion of existing `v*` tags. Existing release tags and binary source identities must stay consistent.
4. Set public-fork workflow approval to `all_external_contributors` and inspect workflow changes before approving execution. Keep write tokens and repository secrets unavailable to untrusted fork workflows.
5. Verify secret scanning and push protection availability/settings for the now-public repository. Enable supported protections and review alerts; an empty alert list is not an exhaustive audit.
6. Read settings back to confirm enforcement. Recheck normal PR CI and release download access. Visibility changes can alter available protections, so do not assume the private-state configuration survived unchanged.

Apply prepared rulesets only after reviewing their impact on active work. No workflow in this repository automatically applies these files or changes visibility. History rewrites, tag movement and deleting old workflow runs require a separate, concrete remediation plan and preserved evidence.

References: [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), [ruleset API](https://docs.github.com/en/rest/repos/rules), [Actions permissions](https://docs.github.com/en/rest/actions/permissions), [visibility changes](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
