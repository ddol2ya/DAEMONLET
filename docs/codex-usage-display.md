# Codex account usage in task bubbles

The expanded activity bubble shows **used** percentages for the Codex account in
Main's saved integration `codexHome`. This is account-wide usage, not the selected
task's usage; selecting another task does not select another account or host.
Hover/read the accessible description for remaining percentage, server reset time
in the OS time zone and app language, and the last successful observation time.
Korean and English are supported. The compact chip keeps its size and includes
usage in its accessible description.

`codexUsageEnabled` defaults to true, migrates through desktop settings, and can
be disabled under Character & appearance. Task bubbles must also be enabled.
Choose **Refresh usage** in the task bubble menu to request a metadata refresh.
Missing/unsupported CLI states direct users to the existing connection settings.
No login window is opened automatically. API-key accounts are not subscription
quota accounts. Disabling usage does not disable task observation.

## Read path and restrictions

Main owns a separate in-memory snapshot, monotonic revision and scheduler. A
configured executable and authentication home are required. The reader works with
side chat OFF and when `ordinaryUsageAllowed` is false. It does not call
`connectVerifiedSideChat` or `connectOfficialSameHome`, check model availability,
create/resume/fork conversations, run turns, reset limits or buy credits.

Each read creates a short-lived, owned official app-server, using the existing
native binary/hash allowlist, environment and same-home restricted launch profile.
Configuration preflight rejects forced login rules, managed/unknown startup layers
and endpoint overrides, and disables configured MCP servers. Server requests are
rejected. The only requests are `initialize`, `configRequirements/read`,
`config/read`, `account/read` (`refreshToken:false`) and `account/rateLimits/read`;
`initialized` is the only notification. The launch profile still sets the existing
model default, but no model catalog or inference request is made. Existing
side-chat authentication, model admission and exhausted-quota blocking are intact.

This starts local processes and contacts official Codex services; it is not an
offline feature. Native Codex owns its normal authentication/cache handling. The
new reader does not parse auth.json or keyring data. The saved integration home,
not a selected task's history source home or side-chat-only CLI preference, is
used. Remote host credentials are not fetched.

The admitted runtime registry currently lists official 0.154.0 for macOS arm64
and Windows x64. The installed macOS runtime's generated experimental TypeScript
schema was checked for `supportsLunaReserve:false` and
`excludeResetCreditDetails:true`. No older runtime is currently admitted, so there
is deliberately **no empty-params retry**. Numeric `-32601`/`-32602` RPC errors
produce an unsupported state, and other errors never trigger compatibility retries.
The JSONL client preserves only a numeric RPC code, not the upstream message/data.

Native admission is cached by resolved executable identity (device, inode, size,
mtime, ctime, mode and owner). Every read re-resolves the selected path and checks
its identity. Replacement requires hash admission again; polling never scans PATH.
Owned processes stop and temporary directories are removed on success, errors,
timeouts and cancellation. Existing Codex processes are never targeted.

## Response policy

- Prefer an explicit `rateLimitsByLimitId.codex`. A corrupt or contradictory entry
  fails closed. Without that entry, the legacy bucket permits missing/null IDs or
  `codex` only. Other/model/reserve/credit buckets are never mixed into it.
- Classify windows by 300/10080 minutes, not primary/secondary position. Missing,
  unknown or duplicate durations leave the affected slot unavailable.
- Accept finite nonnegative percentages up to `Number.MAX_SAFE_INTEGER`. Preserve
  values above 100, round only for display, and clamp remaining to zero. Neither
  rounding 99.6 to 100 nor an elapsed reset determines execution permission.
- Reset timestamps are integer Unix seconds, converted once. Missing/invalid or
  millisecond-looking values leave reset time unknown. Past resets mark the window
  **Rechecking** without setting usage to zero or spinning a retry loop.
- `ordinaryUsageAllowed:false` displays **Usage restricted** independently of the
  percentages; null remains unknown. This snapshot never controls task execution.
- Email and workspace ID are hashed together solely for Main's in-memory scope
  comparison. Neither identifiers nor the hash leave Main. Provider changes cancel
  old generations. Failed fresh reads cannot prove the current workspace identity,
  so V1 conservatively hides previous numbers on failure, even if an old scope hash
  exists. It does not claim to detect external account switches between polls.

## Scheduling and UI

These intervals are product policy, not OpenAI guarantees: 60-second visible
polling, 15-second manual cooldown with single-flight, 10-second RPC timeout,
25-second read deadline, failure backoff 60/120/240/300 seconds with ±5% jitter.
Successful values become stale at 180 seconds and disappear at ten minutes. Reset
boundaries update freshness locally; reads remain limited by the existing schedule.
Visible entry/resume reuses values younger than 60 seconds; stale values are aged
before any new result arrives. Reads pause while hidden, in control/side-chat/
placement mode, during local character chat, suspend and teardown.

The footer reserves the same height for normal and error states. Updates, including
enable/disable, are buffered by the existing pointer, keyboard, focus and menu
interaction lock. Account updates do not change task revisions, selection,
unread/acknowledge state, character poses or notification priorities. No live region
announces every poll. Fallback and anchored placement respect measured height and
activity-page zoom; side-chat sizing remains independent. Constrained work areas
allow scrolling instead of cutting off the footer.

Only the activity-bubble main frame may use the dedicated zero-argument get/refresh
IPC. The controller validates sender/window/frame/URL, arity and request rate.
Initial snapshot/event races discard older revisions. Usage is never persisted;
only its boolean setting is stored. Renderer DTOs contain no raw responses, identity,
paths, tokens or error messages. Production usage logging is not added.

## Verification and limitations (2026-09-26)

The account-free `node scripts/codex-usage-ui-smoke.mjs` uses real Electron windows,
production renderer/preload/controllers and an injected metadata reader. It writes
only synthetic screenshots/results under ignored `outputs/codex-usage/ui`.
Build renderer/electron before running it. It covers Korean/English at
100/125/150/200% zoom, normal/partial/restricted/stale/signed-out, measured fallback
height, a native pointer hold while usage changes, compact width, control pause,
local-chat hiding and unchanged selected task. Unit tests additionally cover
normalization, generations, cancellation, cooldown/backoff, IPC and settings.

A macOS arm64 real-account read completed in approximately 0.6 seconds. Its weekly
bucket and reset matched a near-time Codex app usage-tool read; the response supplied
no 5-hour window. No inference or thread/turn was requested. Cold parent-side
validation/read cost was approximately 151 ms CPU and 38 MiB RSS growth (includes
native hash validation); this is not a long-duration benchmark or a child-process
peak measurement. A separate two-read run at a 60-second interval measured
2.59 s cold / 0.46 s warm latency, 239 / 16 ms parent CPU, at most one owned Codex
child (sampled peak 64 MiB RSS), and zero remaining owned children. Parent RSS was
99 / 120 MiB; two samples do not establish steady-state memory behavior. Real
account data is excluded from fixtures and screenshots.

The macOS run did not verify Windows execution. Subsequent Windows native,
production-package, metadata and fixture results are recorded separately in
[Windows validation](codex-usage-windows-validation.md), including explicit
**NOT_RUN** coverage. Mixed-DPI physical monitors, forced logout/account switches,
real suspend/resume and extended CPU/memory soak remain unverified.
Do not infer Windows success from mocked platform tests. On Windows, run the same
build/test/UI fixture with an admitted native executable, then verify console
suppression, account metadata with side chat OFF, actual sleep/wake and network
loss/recovery. Check process handles/temp directories after cancel/exit and after a
long visible run. Never deliberately exhaust quota or log the user out for testing.

References: [official app-server account API](https://learn.chatgpt.com/docs/app-server)
and the generated 0.154.0 `GetAccountRateLimitsParams`,
`GetAccountRateLimitsResponse`, `RateLimitSnapshot` and `RateLimitWindow` types.

### Commands and final results

- `npm run typecheck`: passed (Node 22.23.0; reused installed dependencies, no upgrades).
- `npm test -- tests/character-pack-validation.test.ts tests/extended-pose-export.test.ts`:
  51 passed; original 64-pose capability/export behavior preserved.
- `npm run test:side-chat`: 161 passed.
- `npm test -- tests/codex-usage-normalize.test.ts tests/codex-usage-service.test.ts tests/codex-usage-reader.test.ts tests/codex-usage-ipc.test.ts`:
  passed; no forbidden RPC observed by the reader fixture.
- `npm test`: 196 files passed, 1,997 tests passed, five skipped. The first sandboxed
  run could not bind loopback mock servers; rerunning with local networking allowed
  resolved that environment issue. Translation coverage and teardown test-double
  omissions exposed during development were fixed before this final run.
- `npm run build:renderer`, `npm run build:electron`, production Electron build and
  `npm run electron:package`: passed. The isolated worktree initially lacked native
  runtime staging; an existing pinned release runtime was hash-verified and copied
  into ignored build staging, with no downloads or installation updates. Existing
  ag-psd/browser and upstream CommonJS build warnings remain.
- `node scripts/codex-usage-ui-smoke.mjs`: passed on macOS with synthetic data.
- Independent production macOS package launched with a temporary profile and
  synthetic unread task, loaded Gpichan, and displayed the missing-CLI usage state
  through the packaged preload/IPC. No account or model calls occurred in that run.
- `git diff --check`: passed. No pack assets/exporter changes, release, installer
  replacement, version tag, distribution-feed change or automatic merge.

Screenshots and detailed machine-local logs are intentionally untracked. The
production package and UI fixtures are separate from the user's installed app.
