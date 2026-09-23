# Windows local character chat

This extends PR #22 from `6f5de4e`; it does not change model selection, persona,
semantic pose IDs or the Mac Metal binary. Windows support targets x64 NVIDIA
CUDA. Native acceptance and build/test success must be reported separately.

## Runtime and packaging

`runtime-catalog.json` is the trust source for each target. Application startup,
staging, Electron build, Forge and NSIS preparation use the same selector and
file verifier. The verifier checks exact lock contents, ordinary-file allowlist,
byte counts and SHA-256; Windows EXE/DLL files must also be AMD64 PE images.
No local lock or newly built binary can establish its own trusted hash.

The pinned llama.cpp source remains
`391fac16460f15233a7740550d858ac96df3419d`. The Windows artifact was built with
CUDA 13.0.48, MSVC 19.35, CMake 3.25.1 and SDK 10.0.22000.0, Release, static MSVC
CRT in a single statically linked llama/ggml executable, OpenMP/OpenSSL disabled, non-native CPU settings
and CUDA architectures 75/86/89. These build targets do not establish tested
minimum GPU requirements. The observed build host is Windows 11 build 26200,
Ryzen 7 5800X, approximately 96 GiB RAM and RTX 4090 24 GiB, driver 610.47.

The first shared-library/static-CRT candidate failed during model loading. A
three-byte native file test reproduced the same `0xc0000409` failure when a
`FILE*` from ggml-base.dll crossed into a different static CRT; the single-CRT
control succeeded. The replacement links llama/ggml statically into one EXE.
The selector rejects the known shared-library/static-CRT combination.

Inspect the actual `dumpbin /DEPENDENTS` graph for every artifact. The remaining
NVIDIA dependency is `cublas64_13.dll` → `cublasLt64_13.dll`; the installed driver
supplies `nvcuda.dll`, which is never shipped. The lifetime owner uses Win32
handles across processes, not CRT file objects across DLLs. Dynamic loader
verification and a consumer machine without the Toolkit are separate native
checks, not implied by a cleaned child PATH.

The Windows-only lifetime host launches only its fixed sibling llama-server,
using Unicode argument quoting and a non-inherited kill-on-close Job Object.
Electron keeps a lifetime pipe open. Closing that pipe terminates the job and
waits for the server before the owner exits; parent/owner death also kills the
owned server. Nothing searches for or kills processes by executable name.

Startup uses loopback/authentication, shell-free hidden processes, verified
runtime cwd, and a child-only PATH limited to runtime/System32/Windows. The auth
directory gets a current-user Windows ACL before the token is written. Readiness
has an elapsed-time deadline and validates CUDA, full layer offload, one slot,
8192 context and one checkpoint. Startup/cleanup belong to individual launches;
cancelled old launches cannot clear a later launch. No CPU fallback is accepted.

Model install/import/delete waits for the owned runtime to stop, blocks new sends
while changing files, and checks runtime/GPU availability before transfer. File
replacement retries transient Windows sharing violations for at most 750 ms;
it never pre-deletes the destination. Existing F1–F4/R1–R2 behavior remains.

## Reproduction

Use a new worktree and private output/profile directories. Do not replace a user
installation. Existing toolchains are prerequisites; these commands do not
install toolchains or download models automatically.

```powershell
./scripts/build-chat-runtime-win.ps1 -LlamaSource <pinned-clean-source> -BuildRoot <new-build-root> -CMake <existing-cmake.exe>
# Review PE/deferred loader dependencies and the catalog before collecting its files.
node scripts/stage-chat-runtime.mjs <reviewed-native-bin-directory> win32-x64
npm run typecheck
npm exec vitest run -- tests/character-chat
node scripts/release/candidate.mjs --platform win32 --arch x64 --output <new-private-candidate>
# Extract the ZIP to a new directory outside the development tree.
node scripts/check-chat-runtime.mjs <extracted-app/resources/local-llm> win32-x64
# Set DAEMONLET_DATA_HOME to a new absolute QA profile before starting the EXE.
# After actual portable UI acceptance, use that exact extracted app:
node scripts/release/installer.mjs --app <verified-extracted-app> --output <new-installer-project>
```

The staged runtime lives under `.generated/character-chat-runtime-package/<target>`
and is copied to real `resources/local-llm`, excluded from app.asar. Source-only
CI can compile without native artifacts; product packaging cannot. Official
model downloads remain an explicit app UI action. Model bytes, QA packs, private
profiles, logs and large artifacts stay outside Git.

To resume, keep the same verified source/artifact identity and QA profile; recheck
all runtime hashes before launching. Use a new artifact directory when source
changes. The model manager resumes its own `.partial` file and verifies the
complete official size/hash before replacement. Do not call a Toolkit-equipped
host with a cleaned child PATH a Toolkit-free consumer test. Do not disconnect
SSH/global networking for an offline test. NSIS creation does not imply safe
installation isolation: use a separate Windows user/VM or approved test identity.

## Sources and redistribution

- [Pinned llama.cpp build instructions](https://github.com/ggml-org/llama.cpp/blob/391fac16460f15233a7740550d858ac96df3419d/docs/build.md)
- [Pinned CUDA CMake rules](https://github.com/ggml-org/llama.cpp/blob/391fac16460f15233a7740550d858ac96df3419d/ggml/src/ggml-cuda/CMakeLists.txt)
- [CUDA 13.0 Windows compiler support](https://docs.nvidia.com/cuda/archive/13.0.0/cuda-installation-guide-microsoft-windows/index.html)
- [CUDA 13.0 EULA, Attachment A](https://docs.nvidia.com/cuda/archive/13.0.0/eula/index.html): cuBLAS redistributables; retain the complete installed EULA/notices in the Windows runtime.
- [Microsoft CRT object boundaries](https://learn.microsoft.com/en-us/cpp/c-runtime-library/potential-errors-passing-crt-objects-across-dll-boundaries?view=msvc-170)
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

The CUDA notice is byte-preserved using Git attributes. It is part of the Windows
runtime's fixed hash allowlist. Existing llama.cpp and dependency notices remain.
No driver, Toolkit directory, model weight or character pack is an app payload.
