# Anime2.5DRig upstream

- Repository: https://github.com/852wa/Anime2.5DRig
- Commit: `d48825867acd081de22b0e7b5585bb562288796d`
- License: MIT, copyright 2026 hakoniwa

Imported files:

- `lib/rigger.js` → `src/engine/anime25d/upstream/rigger.js`
- `lib/genericparts.js` → `src/engine/anime25d/upstream/genericparts.js`

Modifications:

- The UMD root fallback in both files also accepts `globalThis` and exposes the same API on the root even when a CommonJS shim is present, so the browser implementation can be loaded by Vite ESM and Vitest. Rigger algorithms, slot rules, anchor detection, strand detection, synthesis, and image processing are otherwise unchanged.
- `rigger.d.ts` is a local TypeScript declaration only.
- The WebGL code from upstream `index.html` is extracted into `Anime25DRenderer.ts`, with the upstream DOM UI removed and lifecycle/diagnostics exposed as class methods.

Quality-pass extension:

- `cleanPsdLayers` and `buildRig` accept an optional `cleanupThresholds` map. Unspecified layers retain the upstream 40px connected-component threshold; semantic layers can use a lower per-character threshold so neck, eyelash, eyebrow, and mouth pixels are not removed by a global policy. This small signature extension is required because `buildRig` performs its own cleanup pass after adapter preprocessing, so an adapter-only threshold would otherwise be discarded.
- Anchor extraction now tolerates a semantic face, eye, mouth, or neck layer becoming empty after cleanup. It skips the unusable anchor input instead of indexing an empty alpha mask and crashing the whole rig load; diagnostics still report the missing/empty part to the quality UI.
- Eye anchors may fall back to the corresponding eyelash or iris mask when See-through does not emit an eyewhite layer. The warning is preserved in rig diagnostics, while generic closed-eye synthesis remains available instead of disabling blink for the entire character.

Layered-pose runtime note:

- The vendored rigger remains unchanged for pose support. Base and alternate PSDs are each built through the same pinned `Rigger.buildRig()` adapter, while registration, semantic-layer selection, GPU resource ownership, and local layer blending live in the application-side `src/pose/` and renderer modules.

`ag-psd.min.js`, `sample.psd`, `eye_close.psd`, `mouth_close.psd`, and the upstream UI are not vendored. The app uses npm `ag-psd` and the upstream generic RGBA parts embedded in `genericparts.js`.
