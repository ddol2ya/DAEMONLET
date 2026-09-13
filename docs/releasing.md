# Release builds

Use Node 24 and `npm ci`, then `node node_modules/electron/install.js` to install
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
