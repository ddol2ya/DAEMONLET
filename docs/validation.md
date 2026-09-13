# Public source validation — 0.7.0

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
