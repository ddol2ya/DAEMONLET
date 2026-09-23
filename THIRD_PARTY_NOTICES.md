# Third-party notices

## Anime2.5DRig

- Repository: https://github.com/852wa/Anime2.5DRig
- Pinned commit: `d48825867acd081de22b0e7b5585bb562288796d`
- License: MIT, copyright 2026 hakoniwa
- Imported: `lib/rigger.js`, `lib/genericparts.js`
- Adapted: WebGL renderer and parameter-driven deformation from upstream `index.html`
- License copy: `vendor/anime25drig/LICENSE`
- Exact modifications and omitted sample artwork: `vendor/anime25drig/UPSTREAM.md`

## External creator dependencies

ComfyUI and ComfyUI-See-through are user-installed tools. Their source and model weights are not bundled. The creator sends API requests to the user's selected installation. Official installation and model sources are listed in `skills/create-pet-character/external-dependencies.json`.

The model repositories have their own terms; plugin or upstream code licensing does not substitute for a model's terms. No guarantee about arbitrary input artwork rights is made. See `distribution/ARTWORK-NOTICE.md` for the bundled Gpichan provenance.

## npm packages

- `ag-psd` — MIT. Parses user PSDs into RGBA layer data.
- `yauzl` 3.4.0 — MIT. Bounded sequential ZIP reading in the character-pack validation worker; complete license is included in the application.
- `yazl` 3.3.1 — MIT. Creator CLI ZIP export; no code from imported packs is executed.
- React and React DOM — MIT.
- `electron-updater` 6.8.9 — MIT, Electron Builder contributors. Official GitHub provider, Squirrel.Mac and NSIS adapters; paired with builder-util-runtime 9.7.0 and electron-builder 26.15.3. Full transitive notices are collected from the production graph.
- `lazy-val` 1.0.5 declares MIT but its npm tarball and source repository omit a license file. The supplemental notice records that provenance and reproduces the declared MIT terms; it is included in the hashed runtime inventory.
- `sax` 1.6.1 — Blue Oak Model License 1.0.0; the complete upstream `LICENSE.md` is included.
- `semver` 7.7.3 — ISC. Stable version comparison for update selection.
- `@electron/fuses` 2.1.3 — MIT, copyright 2020 Electron Maintainers. Used only to read the packaged runtime's fuse wire; no fuse changes are performed.
- `smol-toml` 1.8.0 — BSD-3-Clause, copyright Squirrel Chat et al. Parses read-only setup configuration.
- `stream-json` 3.6.0 and `stream-chain` 4.2.5 — BSD-3-Clause, copyright Eugene Lazutkin. Stream and discard historical conversation bodies before assembling bounded desktop status metadata. Complete licenses are included in the application.
- Vite, Vitest and TypeScript — MIT development tooling.
- `@electron-forge/core` 8.0.0-alpha.10 — MIT. Explicit macOS candidate packaging uses Forge's public API and process-local config registration.
- `@electron/asar` 4.3.0 — MIT. Build-time verification reads the production ASAR; it is not added to the application runtime.

The signing workflow uses the existing lockfile's `@electron/osx-sign` 2.7.0 (BSD-2-Clause) through Forge/Packager, with explicit JIT-only process entitlements. No Electron/Forge upgrade is part of this workflow.

The build now collects full license texts from the actual renderer module graph and Electron esbuild inputs into `dist/licenses/` and `dist-electron/licenses/`. This includes transitive modules such as pako (MIT AND Zlib), base64-js, scheduler, pend, and ws. The exact package/version inventory is stored with the notices. Electron and Chromium notices are retained in the runtime and copied into the user-facing archive. Project and Anime2.5DRig MIT texts and artwork notices are included too.

CC BY 4.0 covers only provider-controlled rights in DAEMONLET's additional contributions to the inventoried Gpichan visual files, and the separately authorized project icons. It permits modifications and commercial reuse within that rights boundary; see `distribution/ARTWORK-LICENSE.md` and `distribution/ARTWORK-SCOPE.json`. The underlying community character designs, images and reference sheets have unverified creators/terms and are excluded from this project's grant. The available collection and corrected source chain are recorded in `distribution/ARTWORK-NOTICE.md`; the collection's uploader is not established as the original creator or licensor. File hashes do not establish ownership or clearance of complete images. Icon artwork includes the listed tray PNG data embedded in TypeScript; code remains MIT. Other artwork and generated derivatives retain their own source terms. Independent icon provenance and authorization remain unchanged. Anime2.5DRig sample artwork and PSDs are deliberately excluded; its embedded generic parts retain the upstream notice.

The original project MIT attribution, `Momo Motion Lab contributors`, is retained. The accessible initial public-source history does not establish whether that is an earlier project name or a distinct rights holder; ddol2ya/Daemonlet naming alone is insufficient to remove it. Resolving that attribution remains a maintainer review item. This inventory is not a complete original-authorship audit of every line of code.

2026-09-13 external review: ComfyUI's recorded revision provides GPL v3 text. The See-through plugin declares MIT in pyproject.toml but has no root LICENSE file at the compatible commit. LayerDiff3D declares Apache-2.0 in its model card; the exact Marigold weights have no card/license declaration at the recorded revision. Evidence and pending status are in `skills/create-pet-character/external-dependencies.json`. None of these engines or weights are shipped, downloaded or updated by this release build.

In the installed app, project/upstream legal texts and modification notes are beside this file in the external resources `licenses/` folder, with package texts in `renderer/` and `desktop/`. The source-repository paths above identify origins; the public source is https://github.com/ddol2ya/DAEMONLET .

## Local Character Chat runtime and optional models

The optional local-chat runtime is built from llama.cpp commit
`391fac16460f15233a7740550d858ac96df3419d` (MIT; ggml authors).
The staged runtime includes cpp-httplib (MIT), nlohmann/json (MIT),
xxHash (BSD), sha256, rotate-bits and subprocess.h components. Full notices
are in `distribution/licenses/character-chat` and the packaged runtime's
`licenses` directory. The Windows CUDA target additionally redistributes
NVIDIA `cublas64_13.dll` and `cublasLt64_13.dll` from CUDA Toolkit 13.0.
Their complete NVIDIA license and third-party notices are preserved in
`distribution/licenses/character-chat/CUDA-13.0-EULA.txt` and the Windows
runtime's `licenses` directory. Redistribution is described by Attachment A of
https://docs.nvidia.com/cuda/archive/13.0.0/eula/index.html . The NVIDIA driver
and full CUDA Toolkit are not bundled. Model weights are not bundled. The two catalogued
Google Gemma 4 QAT Q4_0 GGUF repositories declare Apache-2.0; the license
text accompanies the model installation information. Character artwork and
source material retain their separate rights and are not covered by these
software/model licenses.
