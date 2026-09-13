# Publication review gates

Keep source preparation, Git history, native distribution, creator ZIP and
external-model rights as separate PASS / BLOCKED / NOT RUN decisions. This work
does not authorize changing visibility, publishing a release, uploading binaries
or merging the PR. On 2026-09-13 the user separately approved history cleanup of
this public-preparation repository, including its affected branch updates.

## Current read-only review — 2026-09-14

Remote main was `37ec67b619eb259245ca97efb9ae9779fa320876`. PRs #1, #2 and #3
were merged; PR #4 remained OPEN at `47c2326e71f2fe511f3ffd7fce2ccac865e64f91`.
The follow-up branch depends on PR #4. These are time-stamped observations, not
permanent branch states. Recheck them before publication.

The existing history checker scanned 15 accessible local refs and 15 commits,
after fetching advertised remote heads, tags and PR head/merge refs. No tags were
advertised. It reported nine environment-literal matches in one **stale local
main** commit: three home paths, one private hostname, four private IP matches,
and one private workspace path. No credential-category matches were reported.
The fetched current remote branches and PR refs did not contain that commit and
had no pattern findings in this scan. Counts describe scanner matches, not nine
credentials or a complete secret audit. The old local ref was preserved.

History remains **BLOCKED for publication review**: server-retained old objects,
cached PR views and existing clones are not certified purged. No history rewrite,
force push, remote deletion, Support contact or credential rotation was performed.
Original reports/ref inventories remain private in ignored outputs. The earlier
cleanup narrative below is historical; its then-open PR status is not current.

## Historical PUBLICATION_BLOCKER_HISTORY_REVIEW

Read-only review on 2026-09-13 found personal environment literals (including
concatenated fragments) in the initial `scripts/release/source-check.mjs`.
The subsequently authorized rewrite removed them from reachable branch history,
along with synthetic fixture matches in four test files. Do not reproduce the
matched values. All descendant commit trees were preserved byte for byte.
The remote `main` and existing PR branch were updated atomically with explicit
leases. At that earlier checkpoint the PR remained open and its head/merge refs used the rewritten history. PR #1 has since merged, as recorded above.

Current local branch history and Codex snapshot trees passed the redacted pattern
scan after rewriting. **The old commit remains retrievable by SHA through GitHub's
API.** Branch cleanup is complete, but server-retained objects, historical PR
views and existing clones are not certified purged. GitHub-controlled PR/cached
objects cannot be removed with a branch push; follow the official procedure below
before visibility review. No support request has been sent. The backup, commit
mapping and detailed evidence remain private and ignored, outside release assets.

At review, the clone was not shallow, advertised remote heads contained only
`refs/heads/main`, no remote tags or existing PRs were listed, and local
`main`, `origin/main`, `origin/HEAD` and the work branch reached this commit.
One historical commit was reachable at the initial review. Additional pattern
matches in four test files were normalized to reserved documentation identities;
these fixture matches are not themselves evidence of real credentials.
No credential pattern was detected in that reachable history. This is not a
guarantee of absence of all secrets. Internal Codex tree/checkpoint refs were
inventoried; the supplemental cleanup check also scanned non-commit trees.
Local reflogs and a private backup remain for recovery during concurrent work;
they are not distributed by an ordinary branch push.
No private development repository was inspected. Repeat ref inventory and
`node scripts/release/history-check.mjs` immediately before publication review.

The authorized cleanup preserves a private, ignored backup and rewrites affected
source scanner and fixture blobs on `main` and `codex/public-release-notices`,
with explicit expected-old-value leases for the remote update. Verify all public
heads/tags plus PR/cached views. Rewriting changes commit IDs and requires clone
coordination. Do not rewrite the private
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
- Preserve the 2026-09-14 community-source correction in ARTWORK-NOTICE.md and
  the pack notice. The original creators and underlying reference terms remain
  unverified; the project's CC BY grant covers only provider-controlled additional
  contributions. A passing build/hash check does not establish image-wide rights.
- The provider separately authorized the explicit project icon inventory under
  CC BY 4.0 on 2026-09-13; preserve that independent provenance and exact scope.
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
