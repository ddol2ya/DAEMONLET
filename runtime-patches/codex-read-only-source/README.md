# Codex read-only paginated source patch

This is a local review patch against OpenAI Codex **rust-v0.154.0**, commit
`6b9826e3aa83b1a5947db50f4332cb9c65f1b340`. It is not an official Codex release.
The patch and its upstream-derived tests remain Apache-2.0 licensed; see LICENSE
and NOTICE. No upstream source checkout or executable is bundled with Daemonlet.

## Why this patch exists

The official `thread/fork` API accepts `path`, but paginated preparation resolves
history using the receiving process's `thread_store`. Its local implementation
persists live state and materializes lineage/projections. Pointing that store at
a user's home would permit source writes. The official 0.154.0 cross-home fixture
fails with `no rollout found for thread id` before a child model request.

The patch adds experimental `readOnlySource: {sourceHome, sourceIdentity}` to
`thread/fork`. The path and logical ID remain required. It requires ephemeral,
excludeTurns, an explicit destination cwd, and no caller-supplied turn boundary
or goal continuation. Other fork paths keep their existing behavior.

Only the new path bypasses destination metadata/settings lookups and store
preparation. It constructs the existing `PreparedFork` from owned typed history
and calls the existing ephemeral fork implementation. There is no source SQLite
connection, source config loading, source migration, database copying, or text
transcript re-import. Model context uses the upstream `ModelContextScan`.

## Source contract

- macOS arm64 app admission; the native reader is macOS-specific. Other OSes
  return SOURCE_PLATFORM_UNSUPPORTED.
- A Main-verified local `sessions/` JSONL with paginated metadata. Physical revert
  rollout IDs and immutable `history_base` ancestors are supported. Archived
  ancestors can be read; archived source selection is not offered.
- Last successful durable TurnComplete boundary, excluding newer incomplete,
  failed, interrupted, or currently writing tails. Native replacement-history
  compaction is used without an app-generated summary.
- Owned regular files, one hard link, no writable group/other bits, canonical
  scoped paths and O_NOFOLLOW. Main also verifies the current OS user. Device and
  inode are decimal strings, never JavaScript floating-point identifiers.
- Read limits: 64 MiB across captured windows and headers; 16 MiB selected typed
  context; 2 MiB per record; 100,000 records; 8 lineage segments; 50,000 filename
  lookup entries; one active reader. A 15-second cooperative deadline and
  cancellation are checked between records and 64 KiB reads. A filesystem syscall
  itself cannot be preempted by this deadline.
- Captured ranges and canonical headers are reread and compared before return.
  Normal appends are permitted; changed/removed/replaced bytes or paths fail.
  The returned SHA-256 describes captured bytes, not the changing whole store.
- The child owns its reconstructed context. Later sends and child compaction need
  no source file handles. Source deletion after preparation does not restore the
  source or switch to another task.
- Compressed segments, unknown typed schemas, malformed records, ordinal gaps,
  dynamic tools and selected capability roots fail closed. Oversized history is
  rejected rather than silently truncated to recent pages.

`sourceSnapshot` reports the actual successful boundary, its time, source identity,
range digest and bounded resource counts. Daemonlet validates it before marking
a child sendable or displaying its context time. These values are Main-owned;
the renderer receives only context time and public readiness/error state.

## Reproduce in a separate checkout

Use a new worktree of the exact upstream commit. Apply `build-lock.patch`, then
`read-only-source.patch` with `git apply --check` and `git apply --binary`.
The release tag's workspace version is 0.154.0 while its lockfile has 150 local
workspace packages at 0.0.0. The separate lock patch changes only these local
versions; external package sources, versions and checksums are identical.

Use isolated CARGO_HOME, CARGO_TARGET_DIR, HOME and CODEX_HOME. The verified build
used existing Rust/Cargo 1.97.1, Xcode 26.5 SDK, just 1.58.0, nextest 0.9.144 and
protoc 36.1. Pin SDKROOT and CC/CXX to the same existing Xcode installation to
avoid a CommandLineTools SDK/linker mismatch. Do not change xcode-select or PATH
configuration files. Run the repository's `just test` commands, not `cargo test`.

```sh
cargo fetch --locked
cargo build --locked -p codex-cli --bin codex
cargo build --locked -p codex-rmcp-client --bin test_stdio_server
just test -p codex-app-server -p codex-app-server-protocol -p codex-rollout
```

The tag's `just write-app-server-schema` points to a removed binary. The existing
native schema writer is an ignored test. Set CODEX_APP_SERVER_SCHEMA_ROOT to the
checkout's app-server-protocol/schema and CODEX_APP_SERVER_SCHEMA_EXPERIMENTAL to
0, then 1; for each run:

```sh
just test -p codex-app-server-protocol --run-ignored only write_schema_fixtures_from_env
```

Generated schema and compressed precomputed exports are included in the patch.
The review executable is a dev build copied to a separate artifact, stripped with
Apple strip and ad-hoc signed. Its exact hash and build evidence are recorded in
the app's runtime admission and private review manifest. Rebuilding can change
the hash: a new build must be reverified and explicitly admitted in code.

## Maintenance and removal

This adds a native build, compatibility, signing/distribution and security-update
responsibility. There is no automatic updater for this binary. The official CLI
continues serving legacy parents. Do not replace an installed CLI or ship this
review binary as an official build. After an official immutable read-only
cross-home source API exists, rerun the same fixtures and remove this patch,
custom hash admission and local binary. Keep the source resolver, public errors,
fixed-boundary validation and recovery regressions.
