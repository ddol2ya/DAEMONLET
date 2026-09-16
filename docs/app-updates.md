# App updates (0.7.2 candidate)

This is the single guide for the updater. Public release approval is separate from building or reviewing a candidate.

## Using updates

Open **Check for updates…** in the character/tray menu, or **Settings → Updates**. Automatic checks default to OFF, including migration from older settings. Enabling them requests public release metadata at most once per day, with an ETag cache and failure backoff. It never downloads an installer or restarts the app automatically. Manual checks are rate limited to prevent repeated clicks.

1. Check for a stable version.
2. Choose **Download**. Closing the settings window or choosing to wait does not schedule installation.
3. Choose **Update and restart…**. A native dialog explains temporary conversation/draft/attachment loss and asks to stop a running owned child if needed. Cancel preserves the current conversation and running child.
4. After consent, the engine verifies/stages the update, settings are saved, owned resources are closed, and shutdown is handed to the updater. Parent Codex tasks are not controlled.

On Mac, accepting step 3 starts Squirrel staging. Once staged, a subsequent normal app exit can apply it even if immediate restart fails. The dialog says this before staging. There is no claimed rollback or staging-cancel action. Temporary conversation text is never written to disk to preserve it across restarts.

## Support and trust

| Installation | Behavior / release gate |
| --- | --- |
| macOS arm64, signed and notarized app in Applications | Official MacUpdater/Squirrel.Mac; digest and size checked, designated signing requirement enforced before staging. Current installation must pass codesign and Gatekeeper. Final archives must pass signing, notarization and fresh extraction checks. |
| Windows x64, per-user NSIS | Official NsisUpdater; requires the installed EXE and new installer to have valid Authenticode signatures matching the configured publisher. Missing publisher/signing credentials block automatic installation. |
| Windows portable ZIP | Manual replacement. The release action targets the versioned Windows x64 ZIP, not NSIS. Back up data stored inside a portable folder before replacing it. |
| Development, unsupported OS/architecture, translocated/read-only/untrusted Mac installation | No automatic installation; show a reason and the official release page. |

Implementation and mocked tests do not establish native platform support. Native signed replacement, local-feed tests, public GitHub hosting and notarization must be reported separately. Windows signing is not optional for automatic execution; unsigned historical installers remain manual-only. No security-failure bypass is exposed.

The first updater-bearing release requires a **manual install** from older public versions such as 0.7.1. In-app replacement is available from that installed version to later versions. Never replace published 0.7.1 assets, reuse a version with different bytes, or install a lower version.

## Fixed engine and feed

- electron-updater **6.8.9**, paired with electron-builder **26.15.3** / builder-util-runtime **9.7.0**. Electron and Forge are unchanged.
- Production provider: public GitHub **ddol2ya/DAEMONLET**, no token, no origin inference, no endpoint setting.
- SemVer stable only; one exact OS/architecture installer asset and matching product metadata. Source archives, creator tools, packs, ambiguous assets, wrong size/hash and mismatched tags are rejected.
- Engine downloads live in its dedicated updater cache. Renderer IPC accepts actions plus a Main-owned candidate UUID, never paths, URLs or executable commands. Generations reject late cancelled work. Existing user packs and Downloads are not cache-cleanup targets.
- With the pinned MacUpdater, autoInstallOnAppQuit=false leaves a downloaded ZIP unstaged. After explicit consent, the public Electron autoUpdater.checkForUpdates stages the engine's private loopback proxy; update-downloaded must succeed before cleanup and quitAndInstall. NSIS never uses Squirrel.Windows.

## Build and metadata (no publishing)

Production builds generate **app-update.yml before Mac signing**; Forge includes it as a resource. The production graph and ASAR checks reject the standalone QA entry and loopback controls. Runtime dependency license texts and hashes are inventoried, including supplemental provenance for lazy-val's omitted license file.

Mac: use the existing signed candidate → explicitly approved notarization → stapling → final archive workflow. Then generate metadata from the **final** ZIP; do not inject resources into an already signed bundle.

Windows: stage an already verified runtime with release:installer. The default historical unsigned build remains available for manual review. For an automatic-update candidate, the runtime EXE must already be signed by the configured publisher; pass --publisher and --certificate-sha1 to stage matching NSIS signing with the existing builder. Private certificate selection stays in the ignored build project. The installer marker preserves the existing appId, executable, per-user scope and data locations. NSIS build always passes publish:'never'; no environment variable can enable upload.

Generate local metadata with:

~~~sh
npm run release:update-metadata -- --artifact <final-versioned-archive> --output <new-directory> --platform darwin --minimum-system-version <Darwin-kernel-SemVer> --manifest <private-signing-manifest>
npm run release:update-metadata -- --artifact <final-versioned-Setup.exe> --output <new-directory> --platform win32 --minimum-system-version <Windows-kernel-SemVer> --packaging-result <installer-build-result.json>
~~~

The output is latest-mac.yml or latest.yml in the official parser's format, containing the final file's version, path, size and SHA-512 plus product/target metadata. The minimum OS field uses the kernel version convention of updater 6.8.9, not the marketing macOS version. Review-only metadata is available with --review and is explicitly rejected by production selection. Metadata generation does not publish a release.

Before an approved public release, prepare every supported platform's final signed assets and metadata in a draft, verify names/digests and version identity, then expose the complete stable release. Do not expose a partial stable feed. Public hosting/redirect behavior needs its own validation; localhost success is not evidence for it.

## Isolated integration testing

scripts/update-smoke.mjs builds two signed **QA applications**, with the real AppController and official updater adapter, into a new private directory. It serves a localhost-only feed and uses a separate profile, cache and ports. The standalone UpdateSmokeEntry is never imported by production main.ts. Its explicit test consent substitutes for the native production dialog and is recorded as such.

The driver can import an existing pack without changing its source file, check download-only without native staging, quit and relaunch N, then write an authorized install marker to apply N+1. It records running versions, settings, pack revisions and a hash of the CLI/consent preferences. These applications are not distributable candidates. A separately built clean production candidate must pass the normal ASAR/signature checks.

Required evidence still includes real UI consent/cancellation, OS termination, native gesture/tray regressions, corrupt download/signature failure, disk/network failure, and actual signed Windows NSIS replacement. Report any unexecuted scenario as NOT_RUN or BLOCKED_CREDENTIALS. Never infer installer rollback, public feed success or Gatekeeper approval from a unit test.

References: [pinned v26 updater documentation](https://www.electron.build/v26/docs/features/auto-update/), [Electron native updater lifecycle](https://www.electronjs.org/docs/latest/api/auto-updater). The installed 6.8.9 source is the behavioral reference for download/staging separation.
