# Character pack update validation

App version remains 0.7.2. Base: PR #20 merged main, 5963e558755b60892d4f749437cd33ebfee8a768. No app release was published and no installed app was replaced.

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

## Checks completed

- Automated suite: 176 files passed, 1,770 tests passed, 5 existing platform skips. New contracts, provider, owner-bound IPC, real registry transitions, metadata-only repack and feed tools are included. The sandbox cannot bind some local sockets; the full suite was run with those required permissions.
- Mac arm64 native QA: all three real appearances passed cancellation, full download/Worker validation, apply via settings preload/Main, renderer-ready selection, draft preservation, unchanged other appearances, rollback and app-update download-busy ownership. Transport was an isolated private fixture; public HF readback is reported separately above. QA seeds use original pack versions plus a private source descriptor, never published.
- Creator ZIP: extracted outside checkout, independent dependency installation, legacy export, persona migration, update-source migration, feed generation, renderer bundling and license preservation passed. ComfyUI/model dependencies were not installed or used.
- Production graph: renderer/Electron build and release structure/negative checks passed; QA transport/hooks excluded.

Windows native execution and final clean-commit candidates are recorded separately when completed. No previous candidate signatures, notarization or native evidence are reused for new bytes. Private paths, input reports and visual captures remain outside Git and HF.
