# Character pack update validation

App version remains 0.7.2. Base: PR #20 merged main, 5963e558755b60892d4f749437cd33ebfee8a768. No app release was published and no installed app was replaced.

## Current stabilization evidence

Latest runtime candidate: **b4dbbb7ab2292dd3707f3ca18e3e531423e76510**, app **0.7.2**, clean at build time. See [the F-01–F-05 findings, ownership changes, candidate boundaries and detailed results](character-pack-update-stabilization.md). PR #21 remains Draft; no merge or public app release is authorized.

The original final Windows candidate `2873290` failed F-01/F-02/F-03. Later `669ab0e` reproduced first-frame timeout and a fallback cycle. Their production failures remain part of the evidence; the historical QA success below does not override them. Candidate `22b54af` passed the scoped normal UI matrix but was superseded after shutdown review findings. Commits `5d4dc97`, `ee6dfb2` and `b4dbbb7` address apply cleanup, separate Main rollback and remaining metadata/preferences I/O. The b4dbbb7 re-review reported no major issues.

| Latest b4dbbb7 layer | Result |
|---|---|
| Direct Mac automated checks | Typecheck, source, creator checks PASS; full suite 180 files, 1,804 passed / 5 skipped |
| Linux CI | 1,801 passed / 8 skipped; Python creator tests 11 passed |
| Windows CI | 1,736 passed / 73 skipped; unchanged-source retry after one pre-existing catalog-test timeout, no timeout adjustment |
| Mac native fault QA | All three updates/cancel/real ready/draft+excerpt/rollback/updater gate and injected-failure recovery PASS. **PRIVATE_QA_TRANSPORT**, not production HF |
| Production structure and independent creator ZIP | PASS; real archive negative controls and extraction outside the checkout, no inference |
| Mac production Settings UI | Three real HF updates, scoped actual artwork, restores and selected-style restarts, actual validation-tab round trip, window-close/explicit cancel cleanup, draft+README preservation and normal native Quit PASS |
| Windows production Settings UI | Three real HF updates, scoped old/new artwork, cancellation, draft preservation, each updated/restored restart and auto-OFF preservation PASS. Separately, original source-less v3/v4/v5 import/selection/artwork and v3/v4 reselection from a preserved failure-profile copy PASS |

Windows native verification is complete within the detailed report’s scope, including final candidate shutdown and protected profile/original hash preservation. The exact new Mac submission was explicitly approved, accepted by Apple, stapled and verified from a fresh final ZIP extraction. Final Mac SHA-256 is `2aa5e6e80a371dc5a7ad7edbbb500df715b8e873ad020831aa1945e7db6a580e`; no older ticket was reused. Both final updater metadata files match the actual bytes. Results are not inferred from previous candidates. Actual-model responses, app updater installation, exhaustive pose/gaze/blink checks and precisely timed native mid-apply quit remain outside production PASS. Deterministic guard/lifetime regressions cover the latter contracts. Private profiles, paths, images and signing state stay outside Git and HF.

## Pack preservation

| Appearance | Retained pack/character ID | Input → output pack version | Unchanged payload files |
|---|---|---|---|
| Asuma Toki v3 | asuma-toki-v3 | 1.2.1 → 1.2.2 | 113 |
| Asuma Toki v4 | asuma-toki-v4 | 1.0.1 → 1.0.2 | 117 |
| Asuma Toki v5 | asuma-toki-v5 | 1.0.1 → 1.0.2 | 117 |

All originals match earlier production reports and their separate delivery copies. Their IDs were already distinct; no ID migration was performed. Only pack.json changed. All payload hashes, character.json, persona, fixed dialogue, artwork, PSD/rig/pose data and provenance are preserved. Original and output archives passed the existing full importer/rig validator. This is byte preservation and installation validation, not a new artwork-production or rights-clearance claim.

## Hugging Face

Public, ungated Dataset: [ddol2/daemonlet-character-packs](https://huggingface.co/datasets/ddol2/daemonlet-character-packs). Artifact commit: d95629dada9f62f6d25dd33ac175f9acf12fd3dd. Final feed commit: 0077f4e823f256c8dde3db7e6c4b796314b50e60.

The initial three artifacts and three documents were uploaded using the authenticated website. Subsequent work uses HF CLI as requested; each independent feed was published by CLI. All three large artifacts were anonymously downloaded through the actual application provider and verified for size and complete SHA-256 before feeds were published. All three published feeds were anonymously retrieved through that provider and matched to the artifact commit/ID/version/runtime/hash. The real redirect path includes us.aws.cdn.hf.co, explicitly allowed by the provider. Only the three packs, three feeds, README, provenance summary, checksums and HF-managed .gitattributes are present.

## Historical feature implementation checks

The following counts are retained from the first feature report (introduced in documentation commit `ece0e9f`, supplemented in `2873290`). They precede later stabilization work and are not the final candidate test totals. Exact latest-source counts and production failures are reported above.

- Automated suite: 176 files passed, 1,770 tests passed, 5 existing platform skips. New contracts, provider, owner-bound IPC, real registry transitions, metadata-only repack and feed tools are included. The sandbox cannot bind some local sockets; the full suite was run with those required permissions.
- Mac arm64 native QA: all three real appearances passed cancellation, full download/Worker validation, apply via settings preload/Main, renderer-ready selection, draft preservation, unchanged other appearances, rollback and app-update download-busy ownership. Transport was an isolated private fixture; public HF readback is reported separately above. QA seeds use original pack versions plus a private source descriptor, never published.
- Creator ZIP: extracted outside checkout, independent dependency installation, legacy export, persona migration, update-source migration, feed generation, renderer bundling and license preservation passed. ComfyUI/model dependencies were not installed or used.
- Production graph: renderer/Electron build and release structure/negative checks passed; QA transport/hooks excluded.

Windows x64: 172 test files passed, 1,702 tests passed and 73 existing platform-specific skips. All three real appearances also passed the same native QA cancellation, preload/Main apply, renderer-ready, draft-preservation and rollback checks in the logged-in interactive session. A production Mac UI check against the public HF feed additionally exercised real download cancellation and active revision application. A further regression test keeps the applying state visible between registry commit and renderer readiness. Final clean-commit candidate identities are recorded in the delivered private artifact report. No previous candidate signatures, notarization or native evidence are reused for new bytes. Private paths, input reports and visual captures remain outside Git and HF.
