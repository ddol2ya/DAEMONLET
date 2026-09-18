# PR #21 character-pack update stabilization

Status: **b4dbbb7 fixes and scoped production verification complete; final Mac archive signed, notarized and verified. Draft, no merge or public release**. App version remains **0.7.2**. Candidate results are scoped to their embedded source commit. Failed candidates and review profiles remain evidence.

User follow-up: after receiving the Windows manual-check checklist, the user reported “윈도우 검수 완료, 이상무” (Windows verification complete, no issues). This records user-reported acceptance of the Windows review, separately from the agent's automated and UI-tool evidence below. The earlier movement/capture observations remain historical evidence, not a continuing user-reported failure. No itemized results or installer-use confirmation were supplied, so this statement does not establish exhaustive pose coverage or Setup.exe installation. It does not authorize merging or publication.

## Findings and ownership

| Finding | Reported behavior | Established cause / change | Verification boundary |
| --- | --- | --- | --- |
| F-01 | Windows v3/v4 selection fails and returns to v5 | Reproduced on 2873290 and again on 669ab0e in an ordinary desktop session. The latter reached GPU commit, then first-frame with `hidden=true`, never reaching ready. Pet now disables background frame throttling; actual rendered-model proof and the 45-second deadline remain required. | One-variable 1c47317 comparison passed (v3/v4 ready 1,313/1,272ms); the reverse 669ab0e control also passed. Thus the intermittent trigger for Windows hidden classification is not conclusively isolated. Both 2873290 control/probe had also passed. Later 22b54af normal UI completed three independent updates, restores and restarts; final-source results are separate below. |
| F-02 | Switching Settings tabs cancels HF validation | Local picker and remote update shared a registry owner. Main now issues distinct operation owners. Tab unmount cancels only its own local picker request; Settings document retirement still cancels remote work. | Before/after regression PASS. Mac f65d9cd and 669ab0e actual HF tab navigation PASS; 669ab0e actual window-close cleanup and new download PASS. |
| F-02, tab return | Cards stay at Loading characters during app-update check | The shared mutation runner dropped the mount-time read while busy. Snapshot reads now run independently. | Reproduced on e22ad85; regression and subsequent actual Mac UI PASS. |
| F-03 | Apply remains blocked after selection failure | Old readiness and chat applying were insufficiently scoped. Main tickets now bind request, renderer generation, ID and revision; only the owning terminal event releases the operation. 669ab0e production trace additionally proved *new fallback operations*, not stale old locks, repeatedly blocking apply (F-05 below). | Ticket/recovery regressions and f65d9cd native fault QA PASS. 669ab0e production recovery FAIL due to F-05; not rewritten as PASS. |
| F-04 | Native menu stays at Preparing to apply after successful update | Applied/error notification happened before candidate cleanup; the cached menu never observed the released owner. Cleanup now emits after clearing its own candidate, and Main refreshes the native menu. | Both success/failure observer regressions fail before 669ab0e and pass after. Mac 669ab0e active HF apply → normal Settings/Quit menu and actual Settings action PASS. Windows 1c47317 and 22b54af ordinary UI menu recovery passed; final-source scope below. |
| F-05 | Failed fallback alternates between previous pet and Gpichan | A last-ready revision remained a recovery target after that same revision had itself failed. Main now retires that proof only for the current matching failure; a failed built-in fallback terminates without starting another transition. | Real Main recovery-method regression reproduces the cycle before 336c244 and passes after; stale failures and failed replacement-revision rollback remain covered. Native b4dbbb7 injected failure → rollback → retry passed. This is private QA evidence, not a reproduced OS failure. Normal 22b54af Windows update/restore/restart did not reproduce the cycle. |

An additional Windows Main stack overflow was traced to a reentrant native hide callback in the task bubble. f65d9cd avoids redundant visibility synchronization and hides only a visible window. Two native-event-order regressions fail before and pass after. This is distinct from F-01.

An actual Mac active-pack update exposed unsent attachment loss. 049cc36 preserves draft excerpts on character changes while still resetting AI conversation history and invalidating the project read scope. Parent/policy/manual resets retain their clearing behavior. f65d9cd production UI preserved a draft and local README lines 1–3 after active v4 and inactive v3 updates; no Send action was performed.

## Baseline comparison limits

The actual three source-less original archives were compared against the published packs: only `pack.json` differs; artwork/runtime payloads match. In 2873290, a clean original-v3 UI import completed selection before a separate repeating Main hide-stack overflow prevented the remaining original imports. Clean public-pack selections passed, while the failing baseline-copy selections did not. These comparisons implicate application/state/lifetime differences without proving a corrupt pack. The prior-main worktree was prepared but its production build/run comparison is **NOT_RUN**; this report does not claim the failure was introduced exclusively by PR #21. Final-source seed transitions, actual source-less originals and failed-profile recovery are recorded separately.

## Rendering and recovery contract

The trace is bounded to 128 structural events, without asset paths, credentials, dialogue or persona text. Diagnostics never authorize readiness. `first-frame` means entry into the frame wait, not completed rendering. Main accepts ready only for the current ticket after the runtime has rendered its committed model. Supersession, document retirement, current AbortError, timeout and recovery settle only the corresponding owner.

The Pet-only `backgroundThrottling: false` setting allows actual animation frames while the transparent companion is backgrounded/occluded. [Electron documents this frame and visibility behavior](https://www.electronjs.org/docs/latest/api/structures/web-preferences). No global GPU/sandbox switch, timeout increase, synthetic ready or removed busy guard is used. Keeping this window scheduled can use more resources when obscured; Settings and other windows keep their existing policy.

## Shutdown lifetime review fixes

Native OS quit can bypass the cached character menu. Review found three separate lifetimes that must finish before registry/window teardown: the active pack application including its `finally` cleanup, Main's separately scheduled failure rollback, and metadata/preferences I/O. Commits `5d4dc97`, `ee6dfb2` and `b4dbbb7` retain those tasks and await them. Repeated normal/update exit callers share one cleanup promise. Initialization cannot subscribe or schedule after disposal. Metadata requests remain independent of the apply/busy gate.

The regressions hold real ownership boundaries open and assert teardown has not happened, then release the I/O and assert completion. Apply success/failure, separate Main rollback, overlapping exit, source/feed/update/automatic/skip writes and initialization fail on their respective prior code and pass after the fixes. No timeout was increased or legitimate busy condition removed. The [b4dbbb7 re-review](https://github.com/ddol2ya/DAEMONLET/pull/21#issuecomment-5721213663) reported no major issues. Normal UI Quit is recorded separately from these deterministic overlap tests; a normal completed-apply exit does not prove mid-apply quit timing.

## Final-source automated verification

Source: `b4dbbb7ab2292dd3707f3ca18e3e531423e76510`, clean at build time, app `0.7.2`.

| Layer | Result | Scope |
| --- | --- | --- |
| Local Mac full suite | PASS: 180 files, 1,804 passed, 5 platform skips | Direct execution; typecheck also passed |
| Linux CI | PASS: 180 files, 1,801 passed, 8 skips | Plus 11 Python creator tests |
| Windows CI | PASS: 176 files, 1,736 passed, 73 skips | Initial attempt timed out in an unchanged desktop-thread-catalog test at 5 seconds; unchanged-source retry passed. No timeout adjustment |
| Native fault QA, Mac | PASS | Three appearances: cancel, preload/Main apply, actual renderer ready, draft/excerpts, other-style preservation, rollback and updater gate. Current AbortError and active-update failure → rollback → retry passed. **PRIVATE_QA_TRANSPORT**, productionCandidate=false |
| Production package structure | PASS | QA input/sink and obsolete surface negative controls rejected; notice checks retained |
| Independent creator ZIP | PASS | Extracted outside checkout; dependency install, legacy export/migration/feed generation/renderer bundling. No model inference |

[Final PR CI run](https://github.com/ddol2ya/DAEMONLET/actions/runs/35274106429). Separate push CI also passed. Source and creator checks were executed locally. The native QA log includes intentional invalid-settings/PACK_LOAD controls, the four expected injected-failure warnings, and four GPU mailbox stderr lines; it reports no renderer-process termination. This is not described as an error-free production run. Reporting-only commit a58d340 also passed CI after an unchanged-source retry: its first PR Windows attempt hit 5-second limits in archive revalidation, metadata-disposal and artifact-identity tests, while its push run passed. Those initial failures are retained; no deadline or app code was changed. Historical counts below belong to their named earlier sources and are not substituted for final-source evidence.

## Final production UI and artifacts

Mac ordinary UI on the signed b4dbbb7 production app completed within this recorded scope:

| Path | Mac result |
| --- | --- |
| Real public HF updates | PASS: v4/v5 active, v3 inactive while v4 remained selected; other pack versions unchanged |
| Unsent data | PASS: exact draft and public README lines 1–3 remained after all three updates; no Send |
| Actual sampled artwork | PASS: v3 updated, v4/v5 old and updated, plus built-in Gpichan. The first v3 rollback had registry/selection/ready proof but no distinct old-version artwork capture |
| Restore and restart | PASS: all three restore operations; cold restart with v5 updated, v4 restored and v3 updated, same versions/selection and auto-check OFF |
| Tab and cancellation | PASS: actual v4 **validating → Updates → still validating → Ready**, Ready cancellation, validation cancellation, confirmation cancellation and actual Settings-close staging cleanup |
| Native menu/exit | PASS: normal Settings/Quit recovered after apply; four native-menu exits returned 0 |

Pure network-stream cancellation timing was not caught. Mid-apply native quit is covered by deterministic ownership tests, not claimed as a production timing success. Mac v3 click coordinates were rejected by the UI tool (NOT_RUN, app-versus-tool cause unconfirmed); v4/v5 click reactions were sampled. Full pose combinations, continuous gaze/blink, drag and every body edge are NOT_RUN. Unsent draft persistence across app restart is not claimed. No model response or actual app installer was invoked.

Windows ordinary UI on the unsigned b4dbbb7 production app completed the source-enabled seed/public-feed matrix: all three selections and actual sampled old/new artwork; public HF downloads, cancellations and confirmation cancellation; active v3/v5 and inactive v4 update with v3 selected; exact unsent draft retained; updated-version and restored-version cold restarts for each appearance, auto-check OFF, other IDs/revisions preserved. Actual Show character OFF → v3 selection → Show ON also reached real ready and displayed v3. App-update checking worked while the pack task continued. These results are not inferred from private QA or previous candidates. Transparent-window captures used an opaque Settings backdrop plus Move/resize and Done; uninterrupted initial desktop visibility without that capture preparation was not established.

In a new copy of the preserved 669ab0e failure profile, v3 and v4 reached ready and displayed their actual artwork without another selection timeout. This proves that limited recovery/reselection run, not a forced OS failure or a same-process post-failure apply. In a separate new profile, the actual source-less original v3/v4/v5 files all passed ordinary UI import, selection and sampled artwork; ready times were 1,209/1,393/1,168ms. Their cards correctly offered no HF source/check controls. Auto adapter startup and side chat were disabled for that isolated original-pack run; no user conversation was chosen or model request sent. No Main recursion dialog was observed in it. Local attachment preservation remains NOT_RUN in Windows production; the explicit excerpt result is Mac plus native QA. Network/validation cancellation boundaries were not always captured; pure stream cancellation remains NOT_RUN. A move-handle test did not change window origin and is a FAIL observation with app-versus-input-tool cause unconfirmed. Scaling changed dimensions, but the immediate artwork capture was inconclusive. Full pose/gaze/blink/edge coverage and native mid-apply quit timing are not claimed. Across the seven baseline-copy runs and one failure-copy run, 32 Chromium cache/network sandbox-access stderr lines remained. HF operations succeeded, but those messages are not characterized as harmless or absent.

The user approved the exact b4dbbb7 submission; Apple accepted it. The candidate was stapled, archived and independently verified from a fresh extraction, including signature, Gatekeeper and Hook host proof. The previous 22b54af ticket was not reused. The same 761 source file contents match across OS after UTF-8-text-only CRLF normalization; native file modes and 729 text line endings make the raw sourceTree hashes differ. Each archive/installer is checked against its own OS source snapshot and embedded build identity.

## Candidate files and preservation

All files remain review artifacts, without a GitHub app release or installation. Both `latest-mac.yml` and `latest.yml` were generated from the actual final ZIP/unsigned installer; their sizes and SHA-512 values were independently matched. The approved submission ZIP (153,768,271 bytes, SHA-256 `6910835c6a8870f4ec9d20e09cab3784ee2655656d4ca62f72106b144e99f59d`) is preserved separately from the final stapled distribution ZIP below.

| File | Bytes | SHA-256 | State |
| --- | ---: | --- | --- |
| Final Mac arm64 ZIP | 153,770,269 | `2aa5e6e80a371dc5a7ad7edbbb500df715b8e873ad020831aa1945e7db6a580e` | Signed, Apple Accepted, stapled, fresh extraction verified |
| Windows x64 ZIP | 183,587,254 | `3101512218553c187c82f17f350d4e5152ab2236b4b017552575c7bd96e68575` | Production UI tested |
| Windows x64 Setup.exe | 101,540,757 | `02db7e7376d9990d97495e4ddbb4b795becd588177b04168e569b18502405a2b` | Unsigned; installation NOT_RUN |
| Creator skill ZIP | 459,300 | `5b1f2b0631d897e1d7d4b9e666796e203662197f19a17ae2d9fd3379e1bfeb0b` | Independent extraction verification PASS |

The Windows ZIP's actual embedded ASAR hash matches the UI-tested app (`4962c6e3e9ce7a163ac96eaa439ea55871f7aa5943f7afbdfd2bd685830851b5`). The signed Mac UI-tested ASAR is `3038268c3fee6937433b75deb53f0bd7691be7158c61530b8d7573fa786e8d04`. Mac execution was on macOS 27.0 build 26A428 arm64; Windows execution was on Windows 11 Pro 25H2, 10.0.26200.9457 x64.

Final Windows readback confirmed zero candidate processes/windows and unchanged protected baseline and production-restart profiles (765 files each). All three actual original pack hashes were unchanged. Four Mac candidate processes exited normally; final staging/transaction directories were empty. No user installation/profile was replaced. Original-only cold restart, Windows local-attachment preservation and same-process production OS-failure-to-HF-retry are NOT_RUN; they are not inferred from the narrower original-import/reselection runs.

## Historical checks and candidate boundaries

- 336c244 local full suite: 180 files, 1,793 passed, 5 platform skips; typecheck PASS. The three added tests invoke the real Main recovery method.
- 669ab0e CI: Windows 1,722 passed / 73 skipped; Linux 1,787 passed / 8 skipped; Python creator tests 11 passed. 1c47317 PR and push CI also passed.
- f65d9cd native QA: all three independent pack updates, cancellation, validation, actual renderer readiness, draft/attachment preservation, rollback, current-load AbortError recovery and active-update failure → rollback → retry PASS. Uses private seeds and fixture transport; **not production HF evidence**.
- Mac 1c47317 production: v4 startup artwork, v5 cold selection and public HF 1.0.2 active apply, actual v5 artwork and normal native Quit PASS. This is separate from the final combined candidate.
- Mac 669ab0e production: v3/v4 actual sampled artwork, all three independent rollbacks, active v3 and inactive v4 public HF apply, tab/app-update concurrency, Settings-close cancellation and post-apply native menu recovery PASS within that run. v5 apply/restart and latest-source full matrix are recorded separately.
- Windows 669ab0e: v3/v4 first-frame failure, fallback cycle and consequent HF apply block **FAIL**. The real selected/ready/lock traces are retained. TokenIsRestricted=false was observed; restricted-launch explanations are not accepted as a confirmed cause.
- f65d9cd Mac was signed, accepted by Apple, stapled and fresh-extraction verified. 669ab0e and 1c47317 were prepared but not uploaded after further production failures were found. None of these records authorizes a newer candidate.

No model response or app-update installation was invoked. Response-in-progress/app-install exclusion is covered by service/guard tests, not claimed as a live model or live installer result. Windows installers are unsigned review candidates and were not installed over the user's app.

## Preserved distribution

The public Dataset remains `ddol2/daemonlet-character-packs`. No repackaging, upload, feed change or pack version increment was performed for these app fixes. Anonymous readback confirmed the previously published artifact bytes and feed contents:

| Independent ID | Pack version | Artifact SHA-256 |
| --- | --- | --- |
| `asuma-toki-v3` | `1.2.2` | `4c7c93cabfe35e00f8d4b697d4f5c9c643e71a799111ecee46409dda7f22feea` |
| `asuma-toki-v4` | `1.0.2` | `de82d0b52b9f0bb01bc7fbb7ce5bc4f5a149376985f47bba801c1d0040b23fe9` |
| `asuma-toki-v5` | `1.0.2` | `abcb8346359ccdd747268e62fb782b27f896422b0371a1def82b759a4a090f89` |

Artifact commit: `d95629dada9f62f6d25dd33ac175f9acf12fd3dd`; feed commit: `0077f4e823f256c8dde3db7e6c4b796314b50e60`. Appearance names v3/v4/v5 remain independent IDs and feeds, never sequential upgrade targets. Artwork, PSD, rigging, motions, fixed dialogue, persona, custom CLI, user installation and user profile were not changed.
