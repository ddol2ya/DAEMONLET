# Windows character chat validation

This records the Windows extension to unmerged PR #22. The implementation starts
from `6f5de4e`; the corrected packaged source is
`6a7930535063e55860c0474bf5e87b4cdcb6e350`. Documentation-only updates do not change
that packaged source identity. No benchmark or model-selection work was resumed.

## Source and regression checks

The final Mac run passed 1,933 tests with five platform-conditional skips. The
Windows host passed 1,864 tests with 74 skips (186 passing files, four skipped
files). Both type checks passed. F1–F4/R1–R2 cover unused/failed initialization,
transactional character ownership, storage limits and failures, safe dialogue
fallback, initialization retry, and cancellation before queued work starts.
Fault-injection and service IO tests are not native UI acceptance.

Source validation checked 815 files and 49 runtime assets without failures.
Release validation found no development assets, retained 434 production inputs,
and rejected missing/altered payloads and prohibited QA content. The new portable
was extracted outside the development directory and its 13 runtime files
(665,682,124 bytes, excluding the lock file) matched the trusted catalog.

The final PR and push CI checks passed. One first Windows CI run timed out after
five seconds in the unchanged `pack-update-service.test.ts` disposal test. The
same-commit second workflow, local Windows suite, and one failed-job rerun passed;
no timeout or assertion was relaxed. The first failure is retained in the local
validation evidence.

## Runtime evidence and failed candidate

The tested Windows host is Windows 11 build 26200, Ryzen 7 5800X, approximately
96 GiB RAM, RTX 4090 24 GiB, driver 610.47. It has CUDA Toolkit installed; this is
not evidence of a Toolkit-free consumer installation or minimum specifications.

The first shared-library/static-CRT candidate (`3bffa3d`) failed its first native
E4B model load with `0xc0000409`. A three-byte file reproduction failed when a
`FILE*` crossed independent static CRTs; a same-CRT control passed. The corrected
runtime statically links llama/ggml into one executable and rejects the known
invalid catalog combination. The old candidate remains failed.

The corrected product supervisor actually loaded E4B with CUDA 43/43 layers,
context 8192, one slot, f16 KV, flash attention and a template reporting
thinking=0. The log also contains CPU-mapped model storage; full layer offload
must not be described as every model byte residing in VRAM. This isolated runtime
start is separate from packaged native UI evidence.

An actual Windows exclusive conversation-file lock caused bounded EPERM failure
at about 793 ms, preserved the original hash, and left no temporary file. After
unlocking, the product storage code saved and reopened successfully. That IO run
used `3bffa3d`; the unchanged storage logic and its final-source tests are distinct
from a final app UI file-lock test. A synthetic native child also verified Unicode
argument preservation and Job Object/lifetime-pipe cleanup; it is not a substitute
for a real model/app hard-exit check.

## Final Windows native UI evidence

The corrected portable launched unelevated from a new Unicode/space-containing
path with an explicit synthetic QA profile. Both E4B and 12B completed Korean
character replies and saved their model-bound messages. The observed E4B-to-12B
transition removed the previous runtime pair before the next pair was observed;
this was endpoint observation, not continuous per-millisecond sampling.

A bounded sequence of fresh native UI observations captured a partial Korean
12B reply while its stop control remained visible. The same method also captured
E4B partial text with a live stop control in a pack using arbitrary pose IDs. Clicking that newly observed
control produced a truncated partial reply marked stopped, with stopped status
in storage. Preparation-stage stop and the following completed request were also
observed. A completed response and isolated history/memory were observed in the
arbitrary-ID pack; this does not claim visual verification of every semantic pose. Earlier screenshots named “stream” only showed preparation or completed
responses and are not streaming evidence. An E4B long numeric output hit the
response limit and was correctly shown/stored as an error.

Normal menu exit removed owned app/runtime processes and their auth file/directory,
preserved the conversation hash, and restart restored completed/stopped messages
and bubble geometry. Actual loaded cuBLAS DLLs came from the packaged runtime;
the observed listener was loopback and unauthenticated props access returned 401.
The auth directory was protected from inherited access and allowed only the
current user. A loaded-model parent-only forced termination removed owned app and
model processes and preserved the conversation hash, but left its auth file and
directory behind. Crash-time credential-file removal is therefore a known
limitation; normal-exit cleanup must not be generalized to forced exit. Restart restored the
conversation after the forced exit. The exact orphaned QA auth directory was
subsequently removed manually after confirming its server was gone; that is test
cleanup, not automatic product cleanup.
This does not establish a Toolkit-free consumer installation or offline-network
acceptance. Physical Korean IME composition was not tested by injected text.

## Final Mac representative regression

A fresh, separately identified QA copy of the final source used the unchanged
Metal binary (`9652de214408ba2bf956af37988c38086ae0d2b39a88c637f05de9e0282db927`).
Actual E4B UI startup cancellation, a subsequent completed response, normal exit,
stored conversation hash preservation, and restart restoration passed. No owned
model process remained after exit. Partial visible text streaming was not captured
in this representative run. Earlier candidates produced non-thinking guard errors;
those failures remain recorded and the prompt/output guards were not relaxed.

## Original-profile protection exception

During an earlier Mac verification attempt, the UI tool auto-launched a QA app
without its explicitly intended profile after a sandboxed launch had failed.
The default desktop-settings and character-transition files were then observed
with updated modification times. Existing conversation, pack registry and Codex
integration files retained earlier modification times, but there was no complete
pre-launch hash baseline; original-byte preservation cannot be claimed for that
incident. Another existing QA desktop-settings file also had a changed timestamp,
whose cause was not established. No speculative restoration or overwrite was made.
Subsequent runs verified a live process with explicit QA environment and a distinct
bundle identity before attaching UI control. Private paths and original data are
not included in Git.

## Distribution artifacts

Both unsigned Windows artifacts contain the application from the clean packaged
source above. No model, character pack, original artwork or conversation is an
application payload.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| Portable ZIP | 702130212 | `e9bea1f61d28a708a93ea112a7335a8bc9524847e5def465f583911c72986e7c` |
| NSIS Setup.exe | 591242550 | `375b0f77313fc7f07980d9671e7af745f8a9167e80e0fc1125c54ede7f3c7fa2` |
| Packaged app.asar | — | `d524d9a510760e0c7e2a964deb7f0da7c768fa88ade20229cabe0dbbb0a3f7b0` |

NSIS was built only after the portable's actual UI conversation/stream/stop tests.
The same extracted portable was its input. All staged payload hashes matched
before and after the installer build. Without executing the installer, its
embedded app was extracted and all 159 files matched the input manifest, including
the same application EXE, app.asar, runtime DLLs and notices. Actual Authenticode
status for both application and installer was NotSigned. Builder logging that
mentions a signing phase does not constitute a signed artifact. Installer build
and extraction are not native installation acceptance.

## Remaining environment limits

Windows Sandbox was disabled. An ordinary NSIS installation under the same user
would share production identity even in another directory, so it is not treated
as safe isolation. Actual isolated install/uninstall, a Toolkit-free GPU machine,
real network disconnection, unsupported native GPU behavior, sleep/resume and DPI
changes need separate evidence. No global driver/Toolkit/Node/Visual Studio update,
security bypass, public release, merge, HF upload or user installation replacement
was performed. Development dependencies were installed only in the approved
validation worktree.

Build and resume instructions: [windows-character-chat.md](windows-character-chat.md).
