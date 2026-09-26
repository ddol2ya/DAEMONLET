# Official side-chat development

## Product boundary

`SideChatSetupController` owns model-free preparation and versioned consent.
`SideChatPreferences` stores only app-local consent, side-chat executable choice and
the dismissed OFF notice. It never overwrites the shared task-control selection.
`SideChatService` keeps drafts, attachments and conversation state in memory.
`SideChatIpcController` validates the existing activity-bubble Main frame, shape,
epoch and request ownership. `ActivityBubbleWindowController` hosts the conversation
inside the task card; there is no standalone chat window/HTML entry. Explicit
activity targets resolve to Main-owned conversation keys and catalog parents without
opening, acknowledging or controlling the parent. A bound parent stays fixed across
background task-list changes; the user can select another task explicitly.

Hook setup, usage and side chat share `adapter/codex/runtime` official-byte admission.
`SideChatDiscovery` reuses standard CLI locations, inspects bounded PATH candidates
without a shell, and resolves npm wrappers without running them. Unknown binaries
are not executed. `OfficialRuntimeRegistry` retains reviewed bytes as an offline
fast path. Other installed official npm native packages at **0.154.0 or newer**
are verified by `OfficialRuntimeVerification`: local package metadata is only a
version hint, and fixed HTTPS npm metadata plus the complete archive SHA-512 and
exact native payload SHA-256/size must agree before launch. Downloads stream into
hashes, never filesystem extraction, installation or execution. Redirects, foreign
URLs, duplicate/link payloads, invalid archives and mismatched bytes fail closed.
The process-local cache holds at most 16 verified release records; no editable disk
cache authorizes execution. Initial verification is bounded to 120 seconds and
cancellable, with 512 MiB compressed and 1 GiB expanded limits.

`SideChatModelPolicy` pins reviewed models and reasoning. Provenance, effective
permission compatibility and account/model readiness are distinct gates. Discovery
is not proof of authentication, a successful fork or a model answer.

Windows uses the same official native-byte admission policy, with POSIX mode-bit checks
limited to POSIX. Native hashes and file identity still gate launch. System policy
is read from `%ProgramData%\OpenAI\Codex`; the child retains the same system
and credential-store locations through a small environment allowlist, without
inheriting user PATH, provider/token overrides or command hooks.

`OfficialSameHomeConnection` launches only the admitted official executable, with
restrictions applied before initialize. Config/requirements, account binding and
catalog are checked again before sending. File credentials retain the protected
account-ID check. Keyring/auto binding requires native `account/rateLimits/read`
accountId and ordinaryUsageAllowed (native code populates the latter only after
matching credential account and user IDs). A fresh restricted reader observes store
changes because a long-lived native process caches authentication. Credentials
never leave Codex; no token injection, keyring dump, login/logout or store conversion.
Missing protocol identity fails closed for keyring/auto. Native `account/updated`
also invalidates the child. Forced-login startup configuration is not admitted:
native application of a mismatch can log out the shared account.

`OfficialParentResolver` reads only selected-parent metadata and bounded native
turn pages. `CodexSideChatBackend` forks through a successful completed turn,
registers the child with observer exclusion, and sends/stops only owned child/turn
IDs. Every turn fixes readonly/never, empty environments/workspace roots and the
reviewed developer policy. Native tools, inherited client tools, Hook/MCP/notify
and unknown approval requests cannot execute through this boundary.

`ProjectReadService` independently enforces canonical project scope, ancestor/file
identity, nofollow, regular single-link text files and limits. Model paths never
reach filesystem APIs. Its selected snapshots are untrusted user data.

## Validation commands

Use a new directory under ignored `outputs/side-chat/<run>/` for reports, logs and
screenshots. Never commit raw answers, credentials, private paths or runtime state.

```sh
npm run typecheck
npm run test:side-chat
npm test
npm run side-chat:probe -- --codex <official-native> --output <new-report.json> --toolHistory --nativeLineage --concurrentParent --compaction
npm run side-chat:probe -- --codex <official-native> --output <new-report.json> --history legacy
npm run side-chat:probe -- --codex <official-native> --output <new-report.json> --parentCompaction
npm run side-chat:probe:tools -- --codex <official-native> --output <new-report.json>
npm run side-chat:probe:startup -- --codex <official-native> --output <new-report.json>
npm run side-chat:prepare-official -- --codex <official-native> --home <selected-home> --parent <explicit-id> --output <new-report.json>
npm run side-chat:ui-smoke -- outputs/side-chat/<run>/ui
```

The backend/startup/tool probes use the production service/backend and official
CLI with an account-free local provider. Fixture process/catalog injection lives
only in `scripts/side-chat/fixture-process.ts`. Positive controls deliberately
demonstrate the prohibited effects in separate unrestricted fixtures; restricted
children must deny them. Windows command-capability positive controls use a
Node sentinel through PowerShell; the Python/build/test labels check the command
boundary, not the presence of those separate toolchains. Startup tests wait for
the three parent Hook events before comparing child effects. Native Windows lock
files are reported as not inspected during store inventory; configuration, Hook
files and explicit parent-record comparisons remain mandatory.

Existing service lifecycle, F1/F2/F3, IME, receipt, epoch,
stale-turn, parent-preservation and permission tests remain necessary.

Production uses compile-time flags to remove QA imports and code, and emits
`dist-electron/bundle-inputs.json`. The build fails if a QA/fixture/custom input
enters the graph. Check ASAR/ZIP contents and source identity too. The general QA
launcher rejects production packages and all old live-account options. Real
production candidates must be driven through normal external UI. No environment
variable authorizes model calls; each live review needs a new explicit budget.

The minimum-version policy is intentionally open-ended, as requested for newer
official npm CLIs. Version labels alone never grant trust. The built-in 0.154.0
hashes also support standalone copies; other standalone layouts without npm
package metadata fail closed (select the official npm installation instead).
The architecture scope remains macOS arm64 and Windows x64. Effective permission,
account identity, model and parent contracts are still checked at connection/turn
boundaries. Missing methods or incompatible parameters do not fall back to weaker
policies. This does not assert that every future upstream API is compatible.

Before claiming a newer CLI has been end-to-end tested, run the real CLI/fixture
matrix including startup effects, concurrency, history formats, tool denials and
process cleanup. Record actual OS discovery, credential-store and packaging
coverage separately. Never silently replace a selected binary or downgrade it.

Report synthetic tests, actual-parent preparation, file reads, account answers and
native HTTP activity separately. UI clicks, accepted submissions and native model
turns are different counts; retries/compaction can create extra HTTP usage. Do not
classify a parent as running from a completed-history snapshot.
