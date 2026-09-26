# Codex usage: Windows validation (2026-09-26)

Windows 11 x64 (build 26200), Node 24.13.1, Electron 43.4.0.
This is a bounded Windows validation, not unrestricted release approval.

## Candidate and isolation

- Tested source: `8fc527daa9d881fd44584abda21a1c9802b1f052`, clean detached worktree.
- Build source-tree SHA-256: `ca6207276461a8fcaf62b7aca92ba7725f38c6949371f76ecf9de9c2231bc03c`.
- App version: 0.8.0; production `app.asar` SHA-256:
  `2430a1b45ae49482b8bc1e085086906260db617924aedefdaec33df7b8dd10a6`.
- Used existing dependencies with an identical lockfile, the existing Electron
  43.4.0 ZIP cache, and a pinned local runtime validated with `verifyRuntime()`.
  No dependency install, upgrade, model download or installed-app replacement.
- Built renderer and production Electron, then packaged with the repository's
  Forge packager configuration through `@electron/packager`, explicitly supplying
  the cached Electron ZIP directory and resolving extra resources against source.
  The initial Forge attempt could not fetch its runtime in the sandbox; the
  offline package completed successfully. This is not a claim that the initial
  `electron:package` command passed.
- Ran the independent executable with separate temporary data profiles and ports.
  Default Gpichan only. Existing checkout, user profiles/packs and GPU jobs were
  preserved. No new images, poses, exports, release, tag or merge.

## Automated checks

| Check | Result |
| --- | --- |
| TypeScript `--noEmit` | PASS |
| Full Windows `vitest run` | PASS: 192 files; 1,928 tests passed, 74 skipped in 4 files |
| Renderer, Electron and production Electron builds | PASS |
| Offline Windows package | PASS |
| `scripts/codex-usage-ui-smoke.mjs` | PASS, synthetic metadata only |
| `git diff --check` | PASS |

The first sandbox test run failed 18 project-read tests because the sandbox
denied `realpath` of the user home. All 18 passed outside that boundary; the final
complete Windows run also passed. Windows skips are retained, not counted as
passes. The UI fixture first encountered a sandbox GPU startup failure and then
a transient `UnknownVizError` during capture. A subsequent complete run outside
the sandbox passed without a source change.

The Electron fixture exercised normal, partial, restricted, stale and signed-out
states; Korean/English at 100/125/150/200%; measured footer height; native Electron
pointer events and interaction buffering; compact width; control-view polling
pause; local-chat hiding; and unchanged selected task. Captured synthetic images
were visually inspected, including both languages at 200%, missing values,
restriction/stale labels, signed-out state and compact mode. This fixture does
not prove physical mixed-DPI monitor behavior or real logout/network recovery.

## Independent production executable

- **PASS:** native Windows capture showed Gpichan and a synthetic unread task with
  the missing-CLI footer. The fixture account was not used by this executable.
- **PASS:** native Settings interaction toggled Codex usage OFF and ON while
  character chat remained OFF. The footer disappeared and returned; the same task
  and unread count remained. The setting persisted across closing/reopening
  Settings. Clean screenshots of both toggle states are retained locally.
- **PASS:** native keyboard navigation opened the task menu; selecting **Refresh
  usage** closed it and retained the missing-CLI state through production IPC.
  This is a missing-provider refresh test, not evidence of a network refresh.
- **PASS:** a second temporary profile selected the already-admitted official
  0.154.0 native CLI and existing authentication home, without copying or reading
  authentication material. With side chat OFF, the production footer's fresh
  accessibility state contained a weekly percentage, an unavailable five-hour
  slot and the unchanged synthetic task. Only boolean assertions were recorded;
  real percentages, reset times, identifiers and scope hashes were not captured
  in screenshots or published logs. This live check is accessibility evidence,
  separate from the synthetic native visual evidence above.
- **PASS:** both test instances exited through the app's normal menu. After the
  final exit, zero processes from the candidate package and zero usage temporary
  directories remained. No name-based bulk termination was used.

Native bubble coordinate input was initially rejected because the tool reported
an overlapping non-target window; activation and a pointer retry did not resolve
it. Settings and character context-menu input worked, and keyboard navigation
reached the bubble menu. Pointer access to that overlapped menu is not marked
PASS. Some transparent-window captures included background UI, so they are not
public evidence; clean synthetic captures and settings captures remain local.

## Live metadata and bounded resource sampling

The production reader independently discovered and hash-admitted the existing
Windows native CLI without executing a shell shim. An initial metadata read took
approximately 1,025 ms and returned a weekly slot, no five-hour slot, and a bound
internal account scope. No values or scope hashes are included here.

A separate reader harness used three reads separated by a 60-second wait:

| Sample | Latency | Parent CPU | Parent RSS | Owned children remaining |
| --- | ---: | ---: | ---: | ---: |
| Cold | 809 ms | 390 ms | 48 MiB | 0 |
| Warm 1 | 947 ms | 47 ms | 46 MiB | 0 |
| Warm 2 | 580 ms | 0 ms at measurement resolution | 47 MiB | 0 |

All three reads succeeded. An additional cancellation left zero owned children
and zero new usage temporary directories. The four owned launches all requested
`windowsHide:true`. This checks the launch option, not continuous visual proof
that no transient console ever appears. Parent CPU/RSS includes harness/runtime
work and is not a child-process peak or an extended steady-state benchmark.

Only the reader's metadata allowlist was used: initialize/initialized,
configRequirements/read, config/read, account/read with refreshToken false, and
account/rateLimits/read. No model catalog, thread/turn, reset credit, purchase,
new login, forced logout or account change was requested.

## NOT_RUN and follow-up procedure

- **NOT_RUN:** physical mixed-DPI monitor transitions and a complete native
  move/resize regression. Use this exact candidate with disposable profiles on
  monitors with different OS scale factors; verify footer bounds after moving
  and resizing and retain clean native captures.
- **NOT_RUN:** real sleep/wake, OS network loss/recovery and real account switching.
  Schedule these with the user so other work is not disrupted; never induce
  quota exhaustion or log the user out. Synthetic/unit coverage is separate.
- **NOT_RUN:** long-duration visible soak, child RSS/CPU peaks, continuous console
  visibility recording, and native hide/disable during an in-flight network read.
  Run a disposable profile for a longer visible interval, track only owned PIDs,
  then hide/disable/quit during a read and inspect handles/temp cleanup. Current
  hide/disable scheduling coverage is automated; live cancellation and normal
  app exit were checked separately above.
- **NOT_RUN:** native manual refresh against the live account. The native menu
  check used the missing-provider profile; live reader and live packaged footer
  checks are separate evidence.

Machine-local logs, temporary profiles and images are intentionally untracked.
Do not publish account-bearing files or background UI captures. This document
adds validation evidence only; it does not change the tested product code.
