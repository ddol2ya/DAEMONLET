# PR #21 character-pack update stabilization

Status: **in progress; Draft, no merge or public release**. App version remains **0.7.2**. The failed production candidate `2873290` and its review profiles remain comparison evidence; their previous results are not approval for a newer candidate.

## Findings and evidence

| Finding | Reported behavior | Established evidence and current status |
| --- | --- | --- |
| F-01 | Selecting v3/v4 fails after rig validation and returns to v5 | Reproduced with the original Windows `2873290` candidate on a copy of the failure profile, with Settings both overlapping and not overlapping the pet. A separate `370f3ad` diagnostic candidate loaded v3 through GPU commit and ready in about 1.2 seconds (`hidden=false`). **Root cause remains open**; this successful diagnostic run does not establish a rendering fix. Fresh-profile/public-pack comparisons are still in progress. |
| F-02 | Leaving the character tab cancels remote pack validation | The old tab cleanup used the same registry owner as the HF operation. A service/registry regression failed before the fix and passes with Main-issued operation owners. Tab cleanup now cancels only its local picker request; actual Settings document retirement still cancels its remote work. Mac production UI retained a downloaded/validated candidate across tab navigation. Windows diagnostic UI also exercised tab navigation during validation; final evidence review remains pending. |
| F-02, tab return | Character cards stay at “Loading characters” when returning during an app-update check | Reproduced in Mac production `e22ad85`. The shared Settings action runner drops work while busy, so the mount-time snapshot request never ran. `e611625` reads the snapshot independently. Its regression fails with the old runner and passes with the fix. Production recheck on this exact commit remains pending. |
| F-03 | `PACK_UPDATE_CHAT_BUSY` persists after a failed selection | The old code used ID/revision-only readiness, a global chat applying flag, and an external apply reservation that could reject internal fallback. `e22ad85` binds ready/failure/timeout to a Main-issued request ID and renderer generation, retires only the owning transition, and authorizes fallback only for that failed owner. Mac `e611625` fault-injection QA completed current-load AbortError recovery and active-update failure → rollback → successful retry. **The remaining lock in the original Windows failure has not yet been conclusively identified**, so QA is not used to close the production report. |

The diagnostic trace is bounded to 128 structural events in the isolated app profile. It contains IDs, revisions, stage timing, renderer generation and lock flags, without asset paths, credentials, dialogue or persona text. Diagnostic events do not authorize readiness. The renderer requires a committed runtime model and an actual rendered frame; Main accepts readiness only for the current ticket.

## Changes and regression scope

- `d9042cb`: distinct Main-owned local/remote import operations, document retirement, stale cancellation protection and candidate expiry cleanup.
- `370f3ad`: bounded transition/load-stage evidence; no claim that instrumentation alone fixes F-01.
- `e22ad85`: renderer/transition-bound ready and failure, owned chat apply cleanup, internal recovery authorization and abortable frame waits.
- `e611625`: tab snapshot reads during concurrent Settings work, terminal cleanup after rejected selection, and explicit failure-path native QA.

Local full suite at `e611625`: **179 files, 1,785 passed, 5 platform skips**. Typecheck and source checks pass. The new read-lifetime regression and the earlier remote-validation cancellation regression each have a recorded failing run before their fix.

Mac native QA at `e611625`: **PASS**, using private seed packs and fixture transport. It checks all three independent appearances for download cancellation, validation, preload/Main apply, renderer readiness, draft preservation, other-appearance preservation and rollback. Two deliberate renderer fetch AbortErrors additionally verify fallback, active-update rollback and retry without restarting the app. The runner accepts only the exact four expected warnings for those two injected failures; unexpected warnings still fail the run. This is not a production HF/UI result.

Mac production checks so far: `370f3ad` v5 → v3 selection, public HF v3 download across tabs, active apply to 1.2.2 and visible v3 artwork; `e22ad85` v4 selection and rollback to 1.0.1. Candidate-specific results remain separate. Full final production checks, normal restart, Windows results and fresh signed/notarized artifacts are still pending.

## Preserved distribution

The public Dataset remains `ddol2/daemonlet-character-packs`. No repackaging, upload, feed change or pack version increment was performed for these app fixes. Anonymous readback confirmed the previously published artifact bytes and feed contents:

| Independent ID | Pack version | Artifact SHA-256 |
| --- | --- | --- |
| `asuma-toki-v3` | `1.2.2` | `4c7c93cabfe35e00f8d4b697d4f5c9c643e71a799111ecee46409dda7f22feea` |
| `asuma-toki-v4` | `1.0.2` | `de82d0b52b9f0bb01bc7fbb7ce5bc4f5a149376985f47bba801c1d0040b23fe9` |
| `asuma-toki-v5` | `1.0.2` | `abcb8346359ccdd747268e62fb782b27f896422b0371a1def82b759a4a090f89` |

Artifact commit: `d95629dada9f62f6d25dd33ac175f9acf12fd3dd`; feed commit: `0077f4e823f256c8dde3db7e6c4b796314b50e60`. Appearance names v3/v4/v5 remain independent IDs and feeds, never sequential upgrade targets. Artwork, PSD, rigging, motions, fixed dialogue, persona, custom CLI, user installation and user profile were not changed.
