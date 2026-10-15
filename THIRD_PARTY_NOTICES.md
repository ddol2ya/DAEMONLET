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
and full CUDA Toolkit are not bundled. The Windows Vulkan chat engine uses
Vulkan-Headers and SPIRV-Headers from Vulkan SDK 1.4.363.0. The original
Khronos notices and license texts accompany it in the runtime `licenses`
directory. The Vulkan loader and driver are supplied by the operating system
and GPU vendor; the SDK is not shipped.
Model weights are not bundled. The two catalogued
Google Gemma 4 QAT Q4_0 GGUF repositories declare Apache-2.0; the license
text accompanies the model installation information. Character artwork and
source material retain their separate rights and are not covered by these
software/model licenses.

### Experimental external Qwen voice engines

Qwen3-TTS official PyTorch model and tokenizer: Apache-2.0, Qwen team.
The optional Apple Silicon arm uses the Apache-2.0 model-card-declared
mlx-community 4bit conversion. MLX Audio, MLX and MLX LM: MIT, their respective
contributors (MLX Audio copyright 2025 Prince Canuma and contributors).
These external packages and model weights are not bundled in the app.
Pinned snapshots, distribution source hashes, and installation license receipts
are documented in `docs/character-chat-voice-qwen-ab.md` and the Qwen policies.
No dots-voice source code or bundled voice is incorporated.

### Optional Windows Qwen GGUF bridge

The ABI definitions used by `qwen_gguf_abi.py` follow qwentts.cpp commit
`6fae92914045cd83364d2845ceaa0f7969727319` (MIT; The omnivoice.cpp authors).
The external runtime uses ServeurpersoCom/ggml commit
`40e16e4a814f7fe851a0c486fb9e8c722e957830` (MIT; The ggml authors).
Their full notices are included in `distribution/licenses/qwentts-cpp-MIT.txt`
and `distribution/licenses/qwentts-ggml-MIT.txt`. This community runtime is
independent from Qwen's official PyTorch runtime.

Serveurperso/Qwen3-TTS-GGUF revision
`b7ee2e8c7459c3bea99da23e3d178125a7d1713c` declares Apache-2.0 for the
Base Q8 model and codec. Model weights are downloaded separately and are not
included in the application package. The Windows x64 release includes fixed
Qwen GGUF native engines, Python packages, and a CUDA redistributable subset in
the managed runtime archives described below. The full CUDA Toolkit and GPU
driver are not included. See `docs/voice-qwen-gguf-windows.md` for the fixed
versions and admission checks.

### Optional Windows VoxCPM2 GGUF and public model downloads

The external Windows Vox engine uses tc-mb/llama.cpp-omni commit
`873056743b74e1a4ce5dcf7290e2298428e214db` (MIT; the llama.cpp authors).
The license is preserved in `distribution/licenses/voxcpm-llama-cpp-omni-MIT.txt`.
The Windows x64 release includes the separately built GGUF engines in managed
runtime archives. The full GPU SDK/toolkit and GPU driver are not included.
VoxCPM2's original OpenBMB weights and the DennisHuang648/VoxCPM2-GGUF
public conversion declare Apache-2.0. The public F16 pair revision is
`169f64d8b98bbaab1761e4ca3a83e6af653456cc`; DennisHuang648 is the conversion
publisher, rather than a claim of direct OpenBMB distribution.
Qwen Base Q8 and its codec are published by Serveurperso at revision
`b7ee2e8c7459c3bea99da23e3d178125a7d1713c`, with Apache-2.0 declared.
The model-only download action requires an explicit model selection and does
not install a Python/native runtime. The combined file preparation action also
checks and connects the selected managed runtime. User-trained voice packs and
their private merged GGUF derivatives are excluded from the public model catalog.

### Bundled Windows x64 managed voice runtimes in the 0.8.4 candidate

The 0.8.4 Windows candidate installer and portable package include six fixed archives outside
`app.asar`, under `resources/voice/managed-gguf-runtime-archives`. Their complete
file inventories and byte hashes are recorded in
`resources/voice/managed-gguf-runtime-catalog.json` and checked against both voice
worker policies. File preparation extracts the selected runtime into the app's
managed voice directory, verifies it, and connects it to the current engine.
Installing runtime files and model files does not by itself load a GPU model or
select a different character voice.

| Archive | Included components and notice locations inside the archive |
| --- | --- |
| `shared-win32-x64-v4.zip` | CPython 3.11.15, Python packages, libsndfile 1.2.2 and its linked codecs, and Microsoft Visual C++ runtime files. Python/package texts are in `python/LICENSE.txt` and package metadata; vendor and codec notices are in `licenses/python-vendor` and `licenses/codecs`. |
| `cuda-redist-win32-x64-v2.zip` | The NVIDIA CUDA/cuBLAS redistributable subset; original terms and notices are in `licenses/CUDA-13.0-EULA.txt`. |
| `qwen-cuda-win32-x64.zip` | qwentts.cpp and ggml CUDA engine; original MIT texts are in `licenses/qwentts-cpp-MIT.txt` and `licenses/qwentts-ggml-MIT.txt`. |
| `qwen-vulkan-win32-x64.zip` | qwentts.cpp and ggml Vulkan engine; the same two original MIT texts accompany it. |
| `vox-cuda-win32-x64.zip` | llama.cpp-omni CUDA engine; original MIT text is in `licenses/voxcpm-llama-cpp-omni-MIT.txt`. |
| `vox-vulkan-win32-x64.zip` | llama.cpp-omni Vulkan engine; the same original MIT text accompanies it. |

Project source code remains under the root MIT license. Third-party runtime
components retain their own original terms; the project MIT grant does not
replace those terms. Microsoft Visual C++ files retain Microsoft's applicable
terms; their redistribution list is
https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution .
The build uses Visual Studio Community 2022, whose original terms are at
https://visualstudio.microsoft.com/license-terms/vs2022-ga-community/ . The
NVIDIA subset retains the original CUDA terms, also available at
https://docs.nvidia.com/cuda/archive/13.0.0/eula/index.html . These references
identify upstream terms and do not assert that redistribution requirements have
been satisfied.

The matching libsndfile and codec source, build recipes, modifications, and
application rebuild instructions are prepared as
`daemonlet-0.8.4-runtime-rebuild-source.zip` for distribution with the matching
binary package. This description does not assert that either candidate has
already been published. Instructions for replacing the
library and regenerating managed runtime pins are also in
`licenses/codecs/RELINK.md` inside the shared archive. The original LGPL and
other upstream rights remain with their respective components.

For the managed Windows voice runtime, the accompanying
`voice/runtime-terms` directory and external `licenses` directory preserve the
original Microsoft Visual C++ V14 (14.51) DOCX, Visual C++ 2015–2022 (14.40,
NumPy vendor copy) English/Korean RTFs, and formatting-only text copies.
`managed-runtime-terms.json` associates each original document hash with the
exact covered DLL paths and hashes. The Microsoft runtime terms apply to those
Microsoft files, not to the project's MIT source or separately licensed open
source components. Original runtime terms are available at
https://aka.ms/VCRedistLicense and
https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/ .
The application's explicit acceptance record gates managed voice installation
and use; it does not grant redistribution rights or establish compliance of the
NSIS, portable, update, or other distribution routes. The distributor's Visual
Studio and NVIDIA redistribution conditions remain separate obligations.
