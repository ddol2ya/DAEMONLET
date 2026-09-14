# Validation records

## Historical observations — 0.7.0 (2026-09-13)

The following observations are preserved as history. They did not capture the app
source SHA and final package hashes, so they do not certify a new candidate with
the same version. New candidate identities and outcomes are listed separately in
[structured records](validation.json); raw evidence stays in ignored `outputs/`.

The public source contains Gpichan's selected 47-file runtime graph, app code,
maintained production helpers, synthetic regression fixtures and required notices.
It excludes historical character artwork, experiment evidence, credentials, weights,
ComfyUI/plugin source, generated app packages and node_modules from Git.

Validation on 2026-09-13:

- Independent `npm ci`: 416 packages, audit reported zero vulnerabilities at that time.
- Typecheck and 134 Vitest files: 1,257 passed, 3 skipped.
- Four synthetic Python image/creator helper checks and skill format validation passed.
- macOS arm64 and Windows x64 production packages: Gpichan only, WebGL, three reloads,
  owned adapter, click-through, visibility and worker/port cleanup passed.
- Ordinary macOS launch displayed **Daemonlet for Codex**, version **0.7.0**.
- The complete creator ZIP was extracted outside the source checkout. Its own lockfile
  installed successfully and no dependency on the old private checkout was needed.
- Three synthetic prepared pose models were assembled into an external payload and
  exported as `.petchar`. Standalone renderer comparison passed 120 static cases,
  90 motion frames and full-model compositing, with zero maximum vertex difference.

The synthetic fixture is a tool contract test, not visual acceptance of a new drawn
character. This pass did not generate artwork, run ComfyUI/model inference or install
production Hooks. Creation remains experimental and requires source-specific geometry,
mask and visual review. Invalid early fixtures were rejected for missing timing, eye
anchors or motion plans; corrected fixtures were checked without weakening validation.

New-name packages are not presented as signed/notarized release artifacts. Run the
explicit signing/notarization and final distribution acceptance for an actual release.
The previous product's notarization does not cover a renamed/rebuilt executable.
See [structured results](validation.json) and [release instructions](releasing.md).

## Candidate-specific review — 2026-09-14 (Asia/Seoul)

[Candidate identities and full file hashes](validation-candidates.json) are separate
from the [public outcome summary](validation.json). Raw logs, screenshots, original
paths and executable check records remain under ignored `outputs/`; the public
summary is not accepted as an evidence record by the validation command.

| Actual candidate | Built source | Executed outcome |
| --- | --- | --- |
| Production ASAR | `a9dcf491952a8f6e18c44382097eb9aec592c857` | Source/type checks, 138 Vitest files (1,301 pass, 3 skip), 4 Python tests, creator:check, both production builds and ASAR/notices/negative fixtures PASS |
| macOS arm64 unsigned ZIP | `2683f0aa762e7b2f53b35b871997a50673bf17a3` | Exact ZIP extraction and complete bundle comparison; native GUI smoke in a new Applications test folder PASS; Developer ID signature check FAIL |
| Windows x64 ZIP and separate EXE | `48cc487718764c840342b638559abcb759f35dc1` | ZIP extraction/file comparison and GUI smoke PASS; NSIS install, 127 payload hashes, installed GUI smoke, uninstall and test data preservation PASS; EXE Authenticode check FAIL (NotSigned) |
| Creator ZIP | `48cc487718764c840342b638559abcb759f35dc1` | Independent extraction, own npm lockfile install, helper load, renderer bundle, selected-asset pack export and preserved notice PASS |
| Synthetic setup ASAR (not distributable) | `a9dcf491952a8f6e18c44382097eb9aec592c857` | Fresh onboarding and relaunch, synthetic Hook installation/repair/removal, settings restore, path drift, foreign Hook preservation and cleanup PASS |

All captured source trees were clean. Later commits only fixed the verification
harness or recorded evidence; the hashes above retain the actual build SHA. The
newer production ASAR is **not** labelled native-tested using an older ZIP result.
Mac and Windows Gpichan canvas captures were visually reviewed. Synthetic smoke
uses a private Windows pipe instead of the real Codex broker. No production Hook,
real-user profile, actual Codex trust state or other application's Hook was changed.
The temporary Mac Applications copy, Windows installation/default test profile and
scheduled task entries were removed from normal app locations after verification;
raw evidence and test artifacts remain private.

The first-run omission was reproduced in an independent checkout: `npm ci` then
`electron:dev` failed copying Electron's missing LICENSE. The revised preflight
reports `npm run electron:install` before building. Explicit preparation, repeat
installation, required-notice rejection and restoration were checked. With the
runtime prepared, the actual development window also exposed a CSP error for
`pet://app/characters/catalog.json`. The HTML now permits that exact asset origin;
protocol CORS is enabled and headers permit only the configured Vite origin.
Electron's [custom-scheme contract](https://www.electronjs.org/docs/latest/api/structures/custom-scheme)
and [cross-protocol enforcement](https://releases.electronjs.org/pr/51152) explain
why header and scheme handling are both required. Sandbox, webSecurity, IPC trust
checks and restrictions on foreign origins remain enabled. Final `electron:dev`
on the clean `2683f0a` checkout launched Vite and Electron, rendered Gpichan/WebGL,
passed three reloads and interaction/visibility smoke, and released all ports.

Two verification portability issues were also reproduced and fixed: macOS `/var`
versus `/private/var` aliases caused a false creator runtime mismatch, and copying
a local Finder `.DS_Store` into a test fixture correctly failed strict pack-path
validation. The verifier now canonicalizes its temporary root and copies only the
existing selected runtime asset graph. Original assets and Finder files were not
deleted, and the pack validator was not relaxed.

The full Windows unit command remains **FAIL**: 60 failed tests / 14 failed files,
1,182 passed and 2 skipped (some suites fail during import). The same PC at PR #4
had 61 failed tests / 15 failed files. These are Unix pathname, socket, launcher and
permission assumptions; the final failure-name set adds no new failures relative
to that baseline. The changed regression subset passed all 40 tests in 4 files.
This comparison does not waive Windows test failures or present a green Windows
suite. The install smoke's first direct PowerShell launch produced no usable runtime
result; the retry through the capturing runner completed and its evidence is retained.

Real Codex start/finish/cancel/restart and trust approval, dialog-based `.petchar`
import, full ordinary macOS install/permission-denial acceptance and update/rollback
remain NOT_RUN. No previous candidate was selected for update comparison. The
Windows uninstall test preserved test-owned settings and extra-pack sentinel files;
it is not evidence of successful pack dialog import. macOS setup used a synthetic
Codex CLI contract, not a real Codex version. No new signing operation, notarization
submission, external binary upload or release publication was performed.
Character reference rights, external-model conditions, historical object cleanup
and the publication decision remain separate unresolved gates in the
[publication checklist](publication-checklist.md).

## Windows regression follow-up — 2026-09-14

A fresh run of merged main `30fbb7fbaaeedad70f109c735d508314dc66d09f` on
Windows reproduced 60 failed tests, 1,212 passed and 2 skipped; four additional
suites failed during import. The historical candidate results above are unchanged.

The follow-up corrects app-preference persistence, activity-history link rejection,
and local lifecycle-file inspection on Windows. Canonical ancestry, file/link type,
opened-handle identity and bounded reads remain checked. Windows does not expose
POSIX owner/group permission semantics through Node's mode bits; the Windows OS
ACL still governs access. This is not a new ACL privacy attestation.
The synthetic Desktop broker now uses a private profile-specific Windows pipe and
requires explicit smoke isolation. It never connects tests to the ordinary broker.
POSIX Hook command parsing uses POSIX path grammar on every test host.

The corrected working-copy suite passed 1,276 tests on Windows with **70 skipped**,
and 1,343 tests on macOS with **3 skipped**, across 140 files. The Windows skips
explicitly identify POSIX Hook launch/install/configuration, Unix mode enforcement,
and the existing platform-specific cases; those are not Windows PASS results.
Hook installation remains a macOS feature; a separate regression verifies Windows
Desktop connection and onboarding persistence without CLI discovery or Hook writes.
The macOS run executes the POSIX cases. New settings tests preserve corrupt/future
files and independent edits, and reject file links, hard links and directory links.
Activity history additionally rejects a replacement between name lookup and open.
Typecheck, source checks, four Python tests and creator runtime checks passed.

The existing Unix CI job is retained, and a Windows job runs source/type/unit,
both production builds and ASAR verification. Unit and build results do not certify
native installation, real Codex use, `.petchar` dialogs, signatures or notarization.
New native candidates require their own source/file identities and fresh evidence.

## Native follow-up and notarized final ZIP — 2026-09-14

The corrected PR6 code at `7857cf7768b31777e2cd36fa4adaf88a5ece5492`
passed both Unix and Windows CI on push and pull request. Windows passed 1,276
unit tests with 70 explicit platform skips; Unix CI passed 1,342 with 4 skips.
Both jobs ran source checks, typecheck, the full unit command, production builds
and ASAR verification. The Unix job also ran the Python and standalone creator
checks. Subsequent validation-summary edits do not change the packaged code SHA.

| Actual candidate | Built source | Newly executed outcome |
| --- | --- | --- |
| Mac regression ZIP | `f0e7e968a86400ba1e6beb20691511ee97a6f95e` | Exact extraction/smoke and native pack import/update/rollback PASS; real CLI 0.153.4 start/finish/cancel/resume and app restart observed |
| Windows regression ZIP/EXE | `f0e7e968a86400ba1e6beb20691511ee97a6f95e` | Runtime smoke and EXE install/replacement/rollback/uninstall PASS, including 127 installed payload hashes and test-data preservation; real CLI start/finish/cancel and app crash/restart observed; EXE remains unsigned |
| Final notarized Mac ZIP | `7857cf7768b31777e2cd36fa4adaf88a5ece5492` | Apple Accepted, ticket/signature/Gatekeeper, final extraction/Hook host, fresh runtime smoke, native pack dialog workflow and isolated normal installation/relaunch/removal PASS |

The final Mac ZIP has SHA-256
`fa3b1c2f3d28b779ec00b990aee4be19d4fbb9035a2f950d1a27326de0c2361e`
and is 153,428,334 bytes. Its new validation identity is
`91207dc2-75bd-4a2f-b29f-379231bf1430`. Signing credentials, Apple submission
identifiers, raw logs and original paths remain private. No binaries were published.

The final ZIP's `.petchar` test used actual native file dialogs and a new profile:
install/apply version 1.0.0, update to 1.1.0, restart with that version selected,
and restore 1.0.0. Both revisions remained present. These fixtures copy the existing
selected Gpichan assets and unchanged notices; no new artwork was produced. The
rendered character was visually checked. A separate Applications test installation
showed first-run onboarding through LaunchServices, preserved the “Later” selection
on relaunch, and was removed while retaining its isolated test settings. No ordinary
user installation, character pack, Codex configuration or Hook was replaced.

The earlier direct-launch voice attempt was terminated by macOS privacy enforcement
under the test host's responsibility. A normal LaunchServices retry with explicit
null standard input subsequently launched successfully. This does not establish a
successful microphone/speech denial test. The user deferred permission prompts and
full Desktop send/stop/trust acceptance; those remain unrun. Real CLI observations
from the older candidates are not copied into the final ZIP's integration result.

The existing Windows install comparison used two real version-0.7.0 candidates.
A distinct-version prior Daemonlet artifact is still needed to verify an actual
version upgrade and downgrade; an artificial version label is not a substitute.
Windows distribution signing remains unavailable. The read-only Git history review
is complete, with retained old objects still requiring a separate publication
decision. No history rewrite or branch deletion was performed.

The [public summary](validation.json) retains its former candidate review unchanged
under `previousCandidateReview`; the [identity inventory](validation-candidates.json)
only appends new candidates. A complete native release or publication approval is
not implied by these scoped outcomes.

Windows CLI cancellation was also checked against the actual 0.153.4 executable
in an isolated native console. The app observed `running` then `cancelled`, the CLI
wrote `turn_aborted`, and the expected interrupted exit was 1. Earlier attempts
could not attach a console, launch the console wrapper, or deliver an enabled
Ctrl+C signal; all failed logs are retained. The successful attempt explicitly
enabled Ctrl+C inheritance in the new test console and verified that every console
process belonged to that test before signaling. It did not signal an existing
user console or task. Test processes and scheduled-task entries were cleaned up.

### User-assisted microphone finding

The user denied Speech Recognition and the final `7857cf7` app displayed the
expected permission guidance without crashing. After the user enabled that
permission and restarted, microphone recovery failed: no microphone prompt or
System Settings entry appeared. macOS TCC identified the responsible main app
as missing `com.apple.security.device.audio-input`; the native helper already
had this entitlement. This is an application signing defect, not an instruction
to repeatedly change the user's settings. Apple's
[audio input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)
is required for Hardened Runtime microphone access.

The signing policy now assigns JIT and audio input to the main app, audio input
alone to the dictation helper, JIT alone to other Electron helpers, and no process
entitlements to frameworks/libraries. Verification rejects missing required keys
as well as extra keys. Regression coverage checks the actual selected plist
contents for bundle and executable paths. A new signed candidate and fresh
microphone acceptance are required; the earlier ZIP and its notarization history
remain unchanged, with this failed recovery recorded separately.

### Dictation completion follow-up

The corrected main-app entitlement allowed the real microphone prompt. The user
confirmed denial guidance, enabled microphone access, restarted, and saw partial
recognition text. The same user then reported that stopping erased that text, so
completed dictation remains unaccepted for the `7fd4a73` candidate.

A regression reproduces a nonempty partial followed by an empty or whitespace-only
partial/final during stop. The service now retains the latest nonempty text in that
recording while still accepting final corrections and clearing its state for the
next recording. The old candidate's result remains separate; the fix needs another
signed candidate and native stop-to-draft verification.

One Windows CI run also exceeded the default five-second outer timeout in the
source-change regression, which creates a Git repository and launches several
Node/Git processes. The affected suite now has a bounded fifteen-second budget;
its assertions and child-process limits are unchanged. The failed run is retained.

### Completed dictation and Desktop acceptance — `c6e7a4d`

The new signed submission ZIP, candidate
`7bfbfcab-299c-4bc7-886b-4829a4581610`, was built from clean source
`c6e7a4df7d3c38912b12397e84504b94362d0453`. Its SHA-256 is
`c13950f1523b86757c0a0bf0fc637766225334ada402789434fdbb5246208e39`
(153,426,349 bytes). The user spoke, stopped dictation, waited, and confirmed
that the recognized text remained editable. CUA independently observed the edited
nonempty draft with recording inactive. The earlier permission and text-loss
failures remain attached to their original candidates.

Using the actual Daemonlet controls and a separately created test task, selection,
send/reply, interruption of the exact active turn, and resend/reply passed.
The interrupted turn had already started a terminal `sleep` command, which
continued and completed later. This verifies Codex turn interruption; it does
not establish termination of external processes. No approval dialog occurred,
and CLI Hook installation/trust acceptance remains unrun. Other tasks were not
sent messages or interrupted.

All four push/PR CI jobs for this source passed. Windows passed 1,280 tests with
70 explicit platform skips; Linux passed 1,346 with 4 skips. The local Mac suite
passed 1,347 with 3 skips. Source checks, typecheck, signing/dictation and validation
source-binding regressions, production builds and ASAR checks passed. Unix CI also
ran Python and standalone creator checks. Skipped platform cases are not native
PASS results.

### Final notarized `c6e7a4d` ZIP

After the user approved the exact submission ZIP above, Apple accepted it. Ticket
attachment and final archive verification produced a separate candidate,
`de5be784-c813-4ff6-893b-2c0dc9c7b949`, with SHA-256
`8c7e2c7cb06670d9675663752fd2f4c7f0d001b39981dc63edb0f1d76ca035c4`
(153,428,329 bytes). Developer ID, ticket, Gatekeeper, extracted bundle and ASAR
verification passed. The built code remains `c6e7a4d`; subsequent documentation
commits do not relabel this artifact as a new source build.

Fresh checks on this final ZIP passed the full Mac unit command with source
identity checked before and after execution, packaged runtime smoke, and the
native file-dialog pack workflow: import/apply 1.0.0, update 1.1.0, restart with
that version still selected, and restore 1.0.0 with both revisions retained.
The rendered character was visually checked. An independent Applications test
installation also passed normal first-run “Later” selection, quit/relaunch
persistence and removal with its isolated settings retained. Test apps were
stopped and original user data and packs were preserved.

Voice and real Desktop controls were exercised on the signed submission ZIP,
before ticket attachment; those results are not copied into this final ZIP's
record. Approval/CLI Hook trust, an actual distinct-version app upgrade/rollback,
Windows distribution signing and the separate publication-history decision remain
outstanding. No repository visibility change, Release, tag, binary distribution,
PR6 merge, history rewrite or branch deletion was performed.
