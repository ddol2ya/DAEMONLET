# Validation records

## Historical observations — 0.7.0 (2026-09-13)

The following observations are preserved as history. They did not capture the app
source SHA and final package hashes, so they do not certify a new candidate with
the same version. New candidate identities and outcomes are listed separately in
[structured records](validation.json); raw evidence stays in ignored `outputs/`.

The public source contains Gpichan's selected 47-file runtime graph, app code,
maintained production helpers, synthetic regression fixtures and required notices.
It excludes historical character artwork, experiment evidence, credentials, weights,
ComfyUI/plugin source, generated app packages and node_modules from Git.

Validation on 2026-09-13:

- Independent `npm ci`: 416 packages, audit reported zero vulnerabilities at that time.
- Typecheck and 134 Vitest files: 1,257 passed, 3 skipped.
- Four synthetic Python image/creator helper checks and skill format validation passed.
- macOS arm64 and Windows x64 production packages: Gpichan only, WebGL, three reloads,
  owned adapter, click-through, visibility and worker/port cleanup passed.
- Ordinary macOS launch displayed **Daemonlet for Codex**, version **0.7.0**.
- The complete creator ZIP was extracted outside the source checkout. Its own lockfile
  installed successfully and no dependency on the old private checkout was needed.
- Three synthetic prepared pose models were assembled into an external payload and
  exported as `.petchar`. Standalone renderer comparison passed 120 static cases,
  90 motion frames and full-model compositing, with zero maximum vertex difference.

The synthetic fixture is a tool contract test, not visual acceptance of a new drawn
character. This pass did not generate artwork, run ComfyUI/model inference or install
production Hooks. Creation remains experimental and requires source-specific geometry,
mask and visual review. Invalid early fixtures were rejected for missing timing, eye
anchors or motion plans; corrected fixtures were checked without weakening validation.

New-name packages are not presented as signed/notarized release artifacts. Run the
explicit signing/notarization and final distribution acceptance for an actual release.
The previous product's notarization does not cover a renamed/rebuilt executable.
See [structured results](validation.json) and [release instructions](releasing.md).

## Candidate-specific review — 2026-09-14 (Asia/Seoul)

[Candidate identities and full file hashes](validation-candidates.json) are separate
from the [public outcome summary](validation.json). Raw logs, screenshots, original
paths and executable check records remain under ignored `outputs/`; the public
summary is not accepted as an evidence record by the validation command.

| Actual candidate | Built source | Executed outcome |
| --- | --- | --- |
| Production ASAR | `a9dcf491952a8f6e18c44382097eb9aec592c857` | Source/type checks, 138 Vitest files (1,301 pass, 3 skip), 4 Python tests, creator:check, both production builds and ASAR/notices/negative fixtures PASS |
| macOS arm64 unsigned ZIP | `2683f0aa762e7b2f53b35b871997a50673bf17a3` | Exact ZIP extraction and complete bundle comparison; native GUI smoke in a new Applications test folder PASS; Developer ID signature check FAIL |
| Windows x64 ZIP and separate EXE | `48cc487718764c840342b638559abcb759f35dc1` | ZIP extraction/file comparison and GUI smoke PASS; NSIS install, 127 payload hashes, installed GUI smoke, uninstall and test data preservation PASS; EXE Authenticode check FAIL (NotSigned) |
| Creator ZIP | `48cc487718764c840342b638559abcb759f35dc1` | Independent extraction, own npm lockfile install, helper load, renderer bundle, selected-asset pack export and preserved notice PASS |
| Synthetic setup ASAR (not distributable) | `a9dcf491952a8f6e18c44382097eb9aec592c857` | Fresh onboarding and relaunch, synthetic Hook installation/repair/removal, settings restore, path drift, foreign Hook preservation and cleanup PASS |

All captured source trees were clean. Later commits only fixed the verification
harness or recorded evidence; the hashes above retain the actual build SHA. The
newer production ASAR is **not** labelled native-tested using an older ZIP result.
Mac and Windows Gpichan canvas captures were visually reviewed. Synthetic smoke
uses a private Windows pipe instead of the real Codex broker. No production Hook,
real-user profile, actual Codex trust state or other application's Hook was changed.
The temporary Mac Applications copy, Windows installation/default test profile and
scheduled task entries were removed from normal app locations after verification;
raw evidence and test artifacts remain private.

The first-run omission was reproduced in an independent checkout: `npm ci` then
`electron:dev` failed copying Electron's missing LICENSE. The revised preflight
reports `npm run electron:install` before building. Explicit preparation, repeat
installation, required-notice rejection and restoration were checked. With the
runtime prepared, the actual development window also exposed a CSP error for
`pet://app/characters/catalog.json`. The HTML now permits that exact asset origin;
protocol CORS is enabled and headers permit only the configured Vite origin.
Electron's [custom-scheme contract](https://www.electronjs.org/docs/latest/api/structures/custom-scheme)
and [cross-protocol enforcement](https://releases.electronjs.org/pr/51152) explain
why header and scheme handling are both required. Sandbox, webSecurity, IPC trust
checks and restrictions on foreign origins remain enabled. Final `electron:dev`
on the clean `2683f0a` checkout launched Vite and Electron, rendered Gpichan/WebGL,
passed three reloads and interaction/visibility smoke, and released all ports.

Two verification portability issues were also reproduced and fixed: macOS `/var`
versus `/private/var` aliases caused a false creator runtime mismatch, and copying
a local Finder `.DS_Store` into a test fixture correctly failed strict pack-path
validation. The verifier now canonicalizes its temporary root and copies only the
existing selected runtime asset graph. Original assets and Finder files were not
deleted, and the pack validator was not relaxed.

The full Windows unit command remains **FAIL**: 60 failed tests / 14 failed files,
1,182 passed and 2 skipped (some suites fail during import). The same PC at PR #4
had 61 failed tests / 15 failed files. These are Unix pathname, socket, launcher and
permission assumptions; the final failure-name set adds no new failures relative
to that baseline. The changed regression subset passed all 40 tests in 4 files.
This comparison does not waive Windows test failures or present a green Windows
suite. The install smoke's first direct PowerShell launch produced no usable runtime
result; the retry through the capturing runner completed and its evidence is retained.

Real Codex start/finish/cancel/restart and trust approval, dialog-based `.petchar`
import, full ordinary macOS install/permission-denial acceptance and update/rollback
remain NOT_RUN. No previous candidate was selected for update comparison. The
Windows uninstall test preserved test-owned settings and extra-pack sentinel files;
it is not evidence of successful pack dialog import. macOS setup used a synthetic
Codex CLI contract, not a real Codex version. No new signing operation, notarization
submission, external binary upload or release publication was performed.
Character reference rights, external-model conditions, historical object cleanup
and the publication decision remain separate unresolved gates in the
[publication checklist](publication-checklist.md).
