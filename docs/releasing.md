# Release builds

Use Node 24 and `npm ci`, then `npm run electron:install` to install
the lockfile-pinned Electron runtime and its Electron/Chromium notices. Electron
43 has an explicit installer instead of an npm postinstall hook. No engine/model
weights are involved. Validate `npm run typecheck`, `npm test`, `npm run build:renderer`
and `npm run build:electron:production` first. The app packages only its runtime
and Gpichan. Creator tools and weights are excluded.

## Windows x64

```sh
npm run release:candidate -- --output outputs/windows-candidate
npm run release:installer -- --app "outputs/windows-candidate/work/Daemonlet for Codex-win32-x64" --output outputs/windows-installer
```

Run `npm install --ignore-scripts` then `npm run build` in that installer project on Windows. It verifies runtime hashes before/after building an NSIS installer. Publication is disabled. Test install, ordinary startup, Gpichan-only selection, profile isolation and uninstall on Windows. State whether the delivered EXE is signed.

## macOS arm64

`npm run electron:package` produces an unsigned development package. To build a signed candidate, use a clean committed checkout on macOS with a valid Developer ID Application identity. Set `MACOS_SIGNING_IDENTITY` and `MACOS_EXPECTED_TEAM_ID`; never commit keys or credential files.

```sh
npm run macos:package:signed -- --output /absolute/private-parent/new-candidate
npm run setup:host-proof -- "/absolute/private-parent/new-candidate/signed/Daemonlet for Codex.app" --output /absolute/private-parent/host.json
npm run macos:notarize -- prepare --candidate /absolute/private-parent/new-candidate
```

Preparation freezes the archive and prints its hash/size; it does not upload. Review that exact archive before the explicit `submit --approved-sha256 <hash>` step. `MACOS_NOTARY_PROFILE` selects an existing Keychain profile; the default is `daemonlet-notary`. Follow with `status`, `staple`, and `macos:archive`. Never call a renamed or rebuilt binary notarized based on an earlier app's ticket. Final extraction, signature, Gatekeeper and runtime checks remain required.

## Creator skill

```sh
npm run creator:package -- --output outputs/creator-release
```

The archive includes the skill and its own runtime source/dependency lockfile, not ComfyUI or models. Extract outside this checkout, run `npm ci` in its runtime and verify `creator.mjs check`, Python helpers, pack export and renderer validation. Do not distribute a instructions-only ZIP as a complete creator.

## Automated distribution gates

After both builds, run `npm run release:verify`, then
`npm run release:check -- outputs/release-verification/app.asar`. The first command
creates an actual production ASAR and rejects missing/empty/altered legal-text
fixtures, validates scoped artwork and checks external resources notices. The
second verifies that real candidate explicitly. These are GPU/signing-free checks
on CI, not native installation, rendering or notarization certification.

Run `npm run creator:verify -- <actual-creator.zip>` to extract outside checkout,
install the creator's npm lockfile, verify notices, load Python helpers and bundle
renderer source, then export a licensed Gpichan verification fixture. The fixture
removes unselected legacy dialogue references only in the temporary copy; original
source illustrations remain unchanged. This is not a newly published character
pack. Set `DAEMONLET_CREATOR_PYTHON` to the test Python if necessary.

All Forge packages carry `resources/licenses/` (macOS `Contents/Resources/licenses/`)
outside ASAR. Windows portable archives/installer staging and macOS candidate
verification check these notices. Project and upstream full texts, modifications,
third-party inventories, Gpichan attribution/scope/CC BY text, and the exact
Electron/Chromium notices must remain available in the installed folder.
The official CC text is stored without Git newline conversion; other text is
copied from the current checkout and compared to its source during verification.

Complete the separate [publication checklist](publication-checklist.md). A passing
current-source or ASAR check does not clear historical commits, model conditions
or unexecuted platform checks. Keep all local evidence under ignored `outputs/`.

## Candidate identity and evidence

Use a Git checkout for source builds. The renderer and Electron builds capture
`sourceCommit`, `workingTreeHasChanges` and a SHA-256 of tracked/nonignored source
inputs in `build-source.json`. Production Electron rejects a renderer from a
different source snapshot. Commit implementation changes before the final build;
subsequent documentation/evidence commits do not change the captured build SHA.

`release:verify` writes `outputs/release-verification/validation.json` alongside
the actual ASAR. `release:candidate` writes a portable ZIP record, installer
builds write a **separate EXE** record, and `creator:verify` writes
`creator-validation.json` beside the tested ZIP. `macos:archive` writes
`final-validation.json` after final extraction/signature/ticket checks. Existing
macOS frozen bundle/archive checks remain mandatory. Rebuilt or legacy candidates
without build provenance must be rebuilt before using the new final archive gate.

Each schema-versioned record contains a unique candidate ID, original build SHA,
source tree hash/dirty state, app version, timestamp/time zone, target OS/arch,
relative artifact names/types/sizes/SHA-256, and separate check entries. Executed
checks include host OS/arch/Node/Codex version (or an explicit untested reason),
command/procedure, timestamp and hashed evidence files. Cross-packaging names the
build host separately; unknown target OS is NOT_RUN, not the host's OS version.

Additional checks against a frozen final archive can use the existing metadata:

```sh
npm run release:validation -- init --record outputs/mac-candidate/validation.json --artifact macosZip:Daemonlet-for-Codex.zip
npm run release:validation -- verify --record outputs/mac-candidate/validation.json
npm run release:validation -- run --record outputs/mac-candidate/validation.json --kind nativePackageSmoke -- node scripts/electron-smoke.mjs
npm run release:validation -- verify --record outputs/mac-candidate/validation.json --required asar --required nativePackageSmoke
```

Before that smoke command, extract **that exact archive**, verify its extracted
bundle against the packaged input (including app.asar and executable hashes), and
set `ELECTRON_SMOKE_EXECUTABLE` to its executable and
`ELECTRON_SMOKE_EVIDENCE_DIRECTORY` under this candidate's `outputs/` directory.
The runner executes the supplied command; it cannot attest a manually mislabelled
command or an arbitrary executable outside the archive. Include extraction/bundle
comparison evidence and review the procedure. Use isolated profiles and synthetic
Codex resources as the existing smoke runner does. Do not use real-user Hook or
Codex settings for candidate smoke.

Creating a record sets **all** checks to NOT_RUN. Integrity verification only
verifies identity and evidence; use `--required` to enforce named completion gates.
A failed command is recorded FAIL and exits nonzero. Missing evidence, changed
hashes or checks copied from another source/candidate fail verification, even for
the same app version. A fresh record is required if signing, stapling, recompression
or any other operation changes bytes; rerun affected checks against the final
files. Never put a final file's hash inside that file itself.

The categories are `unit`, `build`, `asar`, `creatorExtraction`,
`nativePackageSmoke`, `nativeInstall`, `realCodexIntegration`, `signing` and
`notarization`. Manual/interactive checks remain NOT_RUN until executed with a
recorded procedure and evidence. N/A requires a concrete reason; it does not satisfy
a `--required` PASS gate. Mock Hook runs are not real Codex integration. An unsigned
native smoke does not satisfy signing/notarization. Update/rollback needs an
identified previous candidate; otherwise record NOT_RUN and the missing comparison.

Keep original logs, local paths, SSH details, profiles and raw records under ignored
`outputs/` (or the existing private macOS candidate root). Publish only a redacted
summary. Source SHA and final artifact hashes may be copied into a separate public
candidate identity file; no personal environment paths belong there. Technical
checks do not change the separate character rights, external-model, history or
publication decisions. A reviewer must decide publication independently.
