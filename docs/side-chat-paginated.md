# Paginated side chat

PR #17 continues on `feature/character-side-chat` from `5643267` as a Draft.
The existing changes and the new paginated work have not been merged.

## Support

| Runtime / source | Result |
| --- | --- |
| Official CLI 0.154.0, pinned macOS arm64 hash; legacy without dynamic tools | Existing support retained |
| Official CLI 0.154.0; paginated in a different home | PATCH_REQUIRED; native fixture fails before child request |
| Explicitly selected, pinned read-only-source-v1 custom build; compatible uncompressed paginated JSONL | Native memory-only source preparation and child conversation |
| Different version/hash, Windows/Linux, compressed segments, unknown schema or inherited capabilities | Blocked; no automatic promotion or fallback |

The new resolver reads bounded metadata before native preparation. Candidate
metadata does not mean a boundary, authentication, or model answer succeeded.
The first send revalidates the source. The selected parent stays fixed when the
catalog changes. The displayed context time comes from the validated native
snapshot; later parent turns are not automatically inherited. Existing F1/F2/F3,
closed-child recovery, persona roles and text-only execution constraints remain.

See [runtime patch and limits](../runtime-patches/codex-read-only-source/README.md).
No user database, config, authentication file, CLI installation, character pack,
artwork or rig is migrated or replaced. The app has no automatic custom-runtime
download and does not bundle this runtime in its default package.

## Commands and evidence levels

```sh
npm run side-chat:check-parent -- --project <project> --output <new-private-report.json>
npm run side-chat:prepare-parent -- --codex <custom-native> --project <project> --thread-id <selected-id> --output <new-private-report.json>
npm run side-chat:probe -- --codex <custom-native> --output <new-fixture-report.json> --catalog --environments --instructions collaboration-mode --crossHome --readOnlySource
```

The inspector starts no CLI, reads no authentication and makes no model request.
The preparation helper starts one isolated custom CLI and a loopback endpoint
that rejects requests. It allows only initialize/fork RPCs, records counts, and
never saves source text or returned history. It uses the explicit ID or current
CODEX_THREAD_ID matched against the verified local catalog and project.

Fixture variants include `--compaction`, `--parentCompaction`, `--nativeLineage`,
`--concurrentParent`, `--appendDuringFork`, `--destinationCollision`, `--sourceOffline`, and
`--toolHistory`. They operate only on newly created synthetic sources. Raw native
error capture remains confined to the older explicit synthetic reproduction.
Public RPC errors forward only an exact source-code allowlist; other messages
remain redacted.

## Validation record

The detailed immutable runtime/artifact fingerprints and individual JSON reports
are private review artifacts. No actual transcript or screenshot is recorded by
the paginated live harness.

- FIXTURE_PASS: actual native-created paginated sources, 13 completed turns and
  at least 7 pages, page markers, other-thread exclusion, inherited native lineage,
  parent and child compaction, destination ID collision, source closed before
  follow-up, idle source file/byte preservation, concurrent parent completion,
  zero advertised child tools, persona on each turn, exact final bodies.
- Tool and startup controls: actual patch/shell/image/input positive and negative
  fixtures, and Hook/MCP startup controls passed against the custom CLI.
- EXISTING_PARENT_PREPARED: one explicitly selected existing project task, using
  the real resolver and backend, with one CLI, no auth read, no parent RPCs and
  zero model requests. Three metadata candidates were observed; this does not
  claim all three were prepared.
- App regression: 1,551 tests passed and 5 skipped before final artifact creation;
  existing 95 side-chat/persona cases remain, with 8 new source/backend cases.
- Native scoped regression: 1,955 passed, 7 failed, 2 skipped. Remaining failures
  require codex-code-mode-host; locked rusty_v8 150.4.0's macOS arm64 prebuilt URL
  returns 404. They are not reported as passing. The first run also lacked
  test_stdio_server; building that helper resolved 25 failures.
- Formatting: scoped Clippy completed; Rust and Just formatting completed. The
  combined `just fmt` failed only for missing DotSlash and uncached Python Ruff.
  Bazel lock regeneration was attempted but Bazel is unavailable. No external
  Cargo dependency changed; build-only workspace version normalization is separate.
- LIVE_UI_PASS: the packaged review app connected the existing selected paginated
  task through its configured production factory and real character input. Three
  authorized logical submissions produced two rendered answers and one child-only
  interruption, with no failed completed-answer test. Long expansion and exact
  clipboard copy made no additional submission. No transcript/screenshots were
  saved. Context keyword checks matched; this is not a full human semantic review.
  The parent prefix stayed equal and normal append was observed. The independent
  task observer was unknown, so it did not prove the parent's precise UI state at
  the instant of child interruption. Parent RPCs: zero. The old seven-request
  approval was not reused. Logical submissions do not count internal HTTP retries
  or native compaction billing requests.
- The live app used the pinned custom runtime SHA-256
  `6f441d1d428c8b5c9a43e0cfd8794c03a11ae4a6e6a98f67e7c784362293ba22`
  and profile `09cf887a98ac01685216fa082598bc5b4ed95f748a836955dd437700e5a55c86`.
  Final artifact identity is recorded separately; account QA is not automatically
  rerun after documentation or packaging changes.

A whole running user home is never compared by total hash: normal parent writes
are expected. Strict byte/file equality is tested on idle synthetic stores;
concurrent tests check the fixed prefix, excluded active input and normal parent
completion. A real-session prefix check is narrower evidence than whole-store
immutability and is reported that way.
