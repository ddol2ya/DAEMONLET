# Publication review gates

Keep source preparation, Git history, native distribution, creator ZIP and
external-model rights as separate PASS / BLOCKED / NOT RUN decisions. This work
does not authorize changing visibility, publishing a release, uploading binaries,
merging the PR, rewriting history or force-pushing.

## PUBLICATION_BLOCKER_HISTORY_REVIEW

Read-only review on 2026-09-13 found personal environment literals (including
concatenated fragments) in `scripts/release/source-check.mjs:20` of initial commit
`11dfa475b233eef6e218523baa0f4693c800e567`. Do not reproduce the matched values.
The current scanner removes them; that does **not** remove the original blob or
the deletion lines in this PR's diff. Current source passing is not permission to
make the repository public.

At review, the clone was not shallow, advertised remote heads contained only
`refs/heads/main`, no remote tags or existing PRs were listed, and local
`main`, `origin/main`, `origin/HEAD` and the work branch reached this commit.
One historical commit was reachable at the initial review. Additional pattern
matches in five test files were normalized to reserved documentation identities;
these fixture matches are not themselves evidence of real credentials.
No credential pattern was detected in that reachable history. This is not a
guarantee of absence of all secrets. Internal Codex tree/checkpoint refs were
inventoried; non-commit trees and reflogs are outside the commit scanner's scope.
No private development repository was inspected. Repeat ref inventory and
`node scripts/release/history-check.mjs` immediately before publication review.

Separate approval is required to clean affected history: preserve a private
backup, agree the refs/files and retention requirements, use a separately reviewed
`git-filter-repo` plan or a clean publication repository, and verify all public
heads/tags plus PR/cached views. Rewriting changes commit IDs and requires clone
coordination and an explicitly approved remote update. Do not rewrite the private
development repository. Existing clones, forks, old PR diffs and cached views can
retain material even after the code PR is merged. If actual credentials are later
found, classify them separately and arrange revocation/rotation; deleting a path
literal is not a credential rotation. No revocation was performed here.

Official procedure and limits:
https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository

## Source and rights checklist

- Run source, type, JavaScript and Python checks, creator checks and both builds.
- Preserve the existing `Momo Motion Lab contributors` MIT attribution until its
  relationship to ddol2ya/Daemonlet is established. No historical holder removed.
- Keep Anime2.5DRig's hakoniwa MIT text, pinned commit, modifications and embedded
  generic-parts provenance. The source inventory is not a whole-code authorship audit.
- Match every packaged Gpichan visual to `distribution/ARTWORK-SCOPE.json`; the
  original illustrations and user packs must not be changed by license work.
- Confirm separate rabbit-icon rights before broader redistribution claims; the
  Gpichan grant does not automatically cover their independent provenance.
- Resolve the [pending external review](external-license-review.md) separately;
  technical readiness and acknowledgements never grant model permissions.

## Artifact checklist

- Run `npm run release:verify` after renderer and production Electron builds. It
  creates a real production ASAR, checks its exact bytes and external notices,
  and proves missing, empty and altered notice fixtures fail.
- Run `npm run creator:verify -- <actual-creator.zip>`; it extracts outside the
  checkout and installs only npm dependencies to run the bundled tools. No models.
- Native candidates must also pass `release:check` and external resources notice
  checks. ASAR verification is not a Windows install test or macOS signature test.
- Before actual delivery: Windows EXE install/startup, character selection,
  settings, Codex integration, interactions, update/rollback/uninstall; macOS
  signature, notarization, extraction and runtime checks. Record actual runs.
- Keep binaries, local paths, output hashes/logs and signing state in ignored
  local evidence; do not commit experiment artifacts or private machine metadata.
