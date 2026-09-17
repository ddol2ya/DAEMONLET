# PR #21 character-pack update stabilization

Status: **production revalidation in progress; Draft, no merge or public release**. App version remains **0.7.2**. Candidate results are scoped to their embedded source commit. Failed candidates and review profiles remain evidence.

## Findings and ownership

| Finding | Reported behavior | Established cause / change | Verification boundary |
| --- | --- | --- | --- |
| F-01 | Windows v3/v4 selection fails and returns to v5 | Reproduced on 2873290 and again on 669ab0e in an ordinary desktop session. The latter reached GPU commit, then first-frame with `hidden=true`, never reaching ready. Pet now disables background frame throttling; actual rendered-model proof and the 45-second deadline remain required. | One-variable 1c47317 comparison: v3/v4 reached real ready at 1,313/1,272ms with hidden=false and locks released; reverse-order comparison and final candidate matrix pending. Earlier 2873290 control/probe both passed, so that comparison did not establish a cause. |
| F-02 | Switching Settings tabs cancels HF validation | Local picker and remote update shared a registry owner. Main now issues distinct operation owners. Tab unmount cancels only its own local picker request; Settings document retirement still cancels remote work. | Before/after regression PASS. Mac f65d9cd and 669ab0e actual HF tab navigation PASS; 669ab0e actual window-close cleanup and new download PASS. |
| F-02, tab return | Cards stay at Loading characters during app-update check | The shared mutation runner dropped the mount-time read while busy. Snapshot reads now run independently. | Reproduced on e22ad85; regression and subsequent actual Mac UI PASS. |
| F-03 | Apply remains blocked after selection failure | Old readiness and chat applying were insufficiently scoped. Main tickets now bind request, renderer generation, ID and revision; only the owning terminal event releases the operation. 669ab0e production trace additionally proved *new fallback operations*, not stale old locks, repeatedly blocking apply (F-05 below). | Ticket/recovery regressions and f65d9cd native fault QA PASS. 669ab0e production recovery FAIL due to F-05; not rewritten as PASS. |
| F-04 | Native menu stays at Preparing to apply after successful update | Applied/error notification happened before candidate cleanup; the cached menu never observed the released owner. Cleanup now emits after clearing its own candidate, and Main refreshes the native menu. | Both success/failure observer regressions fail before 669ab0e and pass after. Mac 669ab0e active HF apply → normal Settings/Quit menu and actual Settings action PASS. Windows final recheck pending. |
| F-05 | Failed fallback alternates between previous pet and Gpichan | A last-ready revision remained a recovery target after that same revision had itself failed. Main now retires that proof only for the current matching failure; a failed built-in fallback terminates without starting another transition. | Real Main recovery-method regression reproduces the cycle before 336c244 and passes after; stale failures and failed replacement-revision rollback remain covered. Native revalidation pending. |

An additional Windows Main stack overflow was traced to a reentrant native hide callback in the task bubble. f65d9cd avoids redundant visibility synchronization and hides only a visible window. Two native-event-order regressions fail before and pass after. This is distinct from F-01.

An actual Mac active-pack update exposed unsent attachment loss. 049cc36 preserves draft excerpts on character changes while still resetting AI conversation history and invalidating the project read scope. Parent/policy/manual resets retain their clearing behavior. f65d9cd production UI preserved a draft and local README lines 1–3 after active v4 and inactive v3 updates; no Send action was performed.

## Rendering and recovery contract

The trace is bounded to 128 structural events, without asset paths, credentials, dialogue or persona text. Diagnostics never authorize readiness. `first-frame` means entry into the frame wait, not completed rendering. Main accepts ready only for the current ticket after the runtime has rendered its committed model. Supersession, document retirement, current AbortError, timeout and recovery settle only the corresponding owner.

The Pet-only `backgroundThrottling: false` setting allows actual animation frames while the transparent companion is backgrounded/occluded. [Electron documents this frame and visibility behavior](https://www.electronjs.org/docs/latest/api/structures/web-preferences). No global GPU/sandbox switch, timeout increase, synthetic ready or removed busy guard is used. Keeping this window scheduled can use more resources when obscured; Settings and other windows keep their existing policy.

## Checks and candidate boundaries

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
