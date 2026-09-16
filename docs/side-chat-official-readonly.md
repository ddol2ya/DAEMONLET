# Official Codex read-only side conversations

This is the follow-up to PR #17 at `8ca649b`. The PR was still open, Draft and
unmerged when work began, so implementation continues on its existing branch.
The new changes are for review, not automatic merge or release.

## Current contract

The opt-in feature creates a dedicated **official App Server process using the
selected parent's CODEX_HOME**. It creates an ephemeral fork through the last
successful completed turn. It never resumes, steers, interrupts, archives or
modifies the parent. Only a Main-owned child can receive a question or stop.
Opening, hiding, expanding and copying do not submit a model turn.

The child can explain inherited context and user-selected project excerpts, and
propose code/diffs for copying. It cannot apply those proposals, run commands,
build, test, install packages, control apps, call external services, or change
permissions. A snapshot is not a live mirror of the parent. Live status remains
the existing observer's independently timestamped observation; unknown stays
unknown.

### Pinned admission

| Component | Admitted combination |
| --- | --- |
| Native CLI | Official npm distribution `@openai/codex@0.154.0-darwin-arm64` |
| Platform | macOS 27.0 arm64 |
| Native SHA-256 | `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc` |
| Signing team reported by the installed native binary | `2DC432GLL2` |
| Upstream source inspected | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Model | Account-available `gpt-5.6-luna`, low reasoning |
| Auth | Native same-home ChatGPT file credentials; no token injection |
| Policy | `readonly-project-companion-v1` |
| Additional file access | Explicit selection; no automatic search tool |

Admission checks native bytes, ownership, writable modes and executable access.
A filename or version string is insufficient. This does not admit every official
version, another architecture, keychain-only credentials, or managed-policy
environments. Those need separate validation. No installation, PATH or user
application is replaced. A saved custom selection remains visibly unsupported
until the user chooses a verified official executable.

**Provenance qualification:** local `codesign --verify --strict` returned an
invalid-signature result on this host. Signature validity is not claimed.
An independent download of the [published npm artifact](https://registry.npmjs.org/@openai/codex/-/codex-0.154.0-darwin-arm64.tgz)
passed its registry SHA-512 integrity check, and its 222,655,232-byte native
executable matched the admitted SHA-256 byte for byte. Admission uses that
published native digest, not the reported signing-team string. The installed
executable was not repaired, replaced, re-signed or reinstalled.

## Process and model authority

`OfficialSameHomeLaunchProfile` passes process overrides before initialization:
read-only sandbox, never approval, disabled shell/snapshots, hooks, notify,
MCP server entries, plugins/apps, Code Mode/JS, agents, goals, memories, images,
web and permission requests. It preserves the OS HOME for native authentication
and uses the original CODEX_HOME. Its working/temp directories are app-owned.
The environment is an allowlist, not a copy of the parent's environment.

`SideChatPermissionPolicy` reads startup configuration as data, discovers MCP
server names including profiles, and emits per-server disabled overrides.
An empty MCP table is not assumed to erase inherited entries. Native effective
configuration and requirements must pass before fork. Changed configuration or
account binding invalidates the connection before another submission. Unknown
startup layers, incompatible policy, alternate endpoints and custom catalogs
fail closed. Configuration is never temporarily overwritten and restored.

The new path has **no custom model catalog or replacement base instructions**.
Each child turn explicitly carries `environments: []`, read-only/never policy,
low reasoning and the compiled character policy through the supported
collaboration-mode field. No environment is opened to read a file. This removes
native file/command executors even when the parent's tool history includes them.
Inherited client tools can still be named; Main returns a structured refusal
without executing them. Scoped approvals are denied. Stale child/turn requests
are rejected without changing the active turn; unknown requests fail closed.
Denials are bounded to eight per turn and the existing turn timeout/output
limits remain. Tool results and reasoning are not character answers.

Main reads only the account identifier from the existing private auth file to
detect account switches, including switches with the same email. Codex retains
responsibility for credential validation/refresh. Main does not inject tokens,
refresh OAuth, copy auth files, switch accounts or call login/logout. A normal
native token refresh for the same account is distinct from an account change.

The official protocol supports ephemeral paginated forks with `excludeTurns`
and the experimental API opt-in. `thread/turns/list` is paged, bounded to ten
pages of 100 summaries with items omitted. Interrupted/failed turns are skipped:
a separate reader can see a still-running persisted turn as interrupted.
`deferGoalContinuation` cannot be combined with ephemeral on this binary and is
not sent. No unsupported fork `dynamicTools`, `readOnlySource` or snapshot
fields are invented. See the [official App Server contract](https://learn.chatgpt.com/docs/app-server)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Explicit file selection

The installed fork schema does not offer a new client-tool attachment field.
The small file picker therefore sends an approved excerpt to the **same child**
on the next user send. This is not automatic model-driven retrieval and never
uses a shell, `rg`, Node evaluator or independent replacement chat.

`ProjectReadService` binds a Main-selected project root to a conversation epoch.
It validates canonical scope, directory identity, file descriptors, relative
paths, ordinary file type, links and read-time identity. It rejects traversal,
symlink/directory escapes, multiply linked files, special files, binary data,
hidden/credential paths and known private-key headers. Root replacement,
parent/account/integration changes cannot reuse old attachment authority.
Codex worktrees can be scoped to their project subdirectory, never the whole
Codex home. Extension/name screening does **not** guarantee detecting every
secret in an otherwise ordinary source file.

Limits: 1 MiB source file; 400 lines and 32 KiB returned per selection; eight
files and 128 KiB total per submission. Excerpts include relative names, line
numbers, read times and partial-range flags. Only metadata reaches the renderer;
contents remain in Main until sent. A file change does not silently update an
already selected snapshot. Invalid reads return an error without destroying an
otherwise healthy conversation. Reset/policy changes clear attachments while
preserving an unsent draft.

## Storage and observer boundaries

Daemonlet bodies/drafts/excerpts are memory-only in ordinary use. The official
engine may update its own indexes, SQLite WAL/shared-memory files, locks, logs,
authentication and caches. Model tools cannot use that permission. Tests observed
state/history/log/goal/memory/queue database bookkeeping and arg0 locks; the
parent's own concurrent append was reported separately. The app does not update
Codex databases, delete original logs, or restore files to conceal side effects.

Ephemeral fixture children were absent from stored thread lists and had no
fixture reply/child-ID disk matches. This is not a universal provider/log
zero-retention promise. Parent messages, completion boundaries, config/hooks,
project files and process continuity are checked separately. Child exclusion is
acknowledged before the first user turn; ephemeral children do not enter the
normal stored task list during the registration gap.

## Verification record — 2026-09-16

These are direct results from this follow-up, not the old custom-runtime PASS.

| Level | Result and limits |
| --- | --- |
| `OFFICIAL_SAME_HOME_FIXTURE_PASS` | Real application service/backend + pinned official CLI + loopback fake provider. Multiple paginated pages, native lineage and compaction, completed boundary, concurrent parent append/completion, first/follow-up/long responses, two child compactions, persona delivery, child exclusion and cleanup passed. |
| Execution controls | 22 actual-CLI positive/negative trials passed: patch, shell, Python/Node, fixture build/test programs, images, input requests and a loopback network receiver; Code Mode, JS, web and inherited client-tool attempts refused. The network receiver was reached once in its positive control and zero times by the restricted child. Positive controls are confined to fixture processes. A tool name alone is not the verdict. |
| Startup controls | Trusted Hook/MCP/notify sentinels ran in the separate parent positive control. Their byte counts did not increase through child spawn, initialize, fork, first turn, follow-up or close. Parent config/hooks stayed unchanged through the child path. Parent initialization itself added its own trusted project entry, recorded before the child baseline. |
| `EXISTING_PARENT_PREPARED` | The user's second explicitly selected existing parent passed native metadata/account/catalog/policy and ephemeral fork preparation. Zero logical model submissions and parent control calls; successful parent boundaries and user config/hooks preserved. HTTP traffic was not instrumented. |
| First selected parent | `NO_PARENT`: no successful completed turn. Blocked before fork/model submission; not counted as a preparation PASS. |
| `READ_ACCESS_VERIFIED` | Explicit file selection delivered exact code and line numbers to the same child. Traversal, secret names, binary/private-key fixtures, links, root replacement and bounds were tested. Automatic retrieval is not provided. |
| Synthetic UI | Actual renderer/preload/IPC: file selection, exact copy, long/compact/panel, IME, hidden-window reuse, draft revisions, disconnection and explicit recovery passed. Responses here were synthetic. |
| Packaged app | macOS arm64 package/ASAR assets and license checks passed. Existing Toki v4 copy and Gpichan applied successfully; authored head/torso interactions passed. No pack, illustration, rig or production skill was regenerated. |
| Real account UI | Completed across two scoped packaged runs under the new four-submission approval: two Gpichan replies, one interrupted child turn and one Toki reply. Inherited context, README line citations, long text, exact copy and explicit new conversation were checked. Parent rollout bytes, config and hooks stayed unchanged in both runs. |
| Other OS connections | `NOT_RUN`. Cross-platform CI is not a live Codex connection test. |

Private reports, auth/config data, task identifiers, transcripts, screenshots,
review app and pack copies are excluded from Git. The real-account harness has a
distinct new approval marker; legacy three/six/seven-call markers do not enable
it. Logical submissions are not a count of internal HTTP retries/compaction.

The first live harness counted four **UI attempts** as submissions. Its fourth
attempt did not reach a model: character switching re-applied the still-OFF app
setting, and the service rejected input while disabled. The first raw report is
retained as FAIL with `LIVE_DEADLINE`, not silently rewritten. The harness now
enables the setting in its isolated test profile and counts accepted submission
receipts. The remaining one authorized submission completed the Toki check.
There were three rendered model answers and one interrupted model turn; internal
HTTP retries and compaction billing were not measured. This is not claimed as
one uninterrupted four-step run. The two app artifacts differ in the QA setup
and counting correction; the production child policy/profile was identical.

Actual response review confirmed that the first answer used the inherited
image-production discussion, the follow-up cited matching README lines and
provided an unapplied diff, and Toki used the existing polite voice/address.
This is a scoped semantic check, not a general persona-quality benchmark.
Real-parent live running/idle status was not independently observed. Concurrent
running-parent continuity and post-compaction persona/policy were tested with
the actual CLI and fake provider, not billed as real-account results.

Final local checks: typecheck, 135 side-chat/persona tests, **1,583 full-suite
tests passed / 5 skipped**, renderer and production Electron builds, source
scan and ASAR asset/license checks. The sandboxed full-suite attempt could not
bind local test sockets; the same suite passed with local communication allowed.

## Reproduction

Use a pinned native executable and new private report paths. Fixture commands
do not use a real account. Their only provider difference is constructor-level
loopback injection; no production setting or renderer route enables it.

```sh
npm run side-chat:probe -- --codex <official-native> --output <new-report.json> --officialSameHome --concurrentParent --compaction --parentCompaction --nativeLineage --toolHistory --hostileParent
npm run side-chat:probe:tools -- --codex <official-native> --output <new-tools.json> --officialSameHome
npm run side-chat:probe:official-startup -- --codex <official-native> --output <new-startup.json>
npm run side-chat:prepare-official -- --codex <official-native> --home <selected-home> --parent <explicitly-selected-id> --output <new-private-report.json>
npm run typecheck
npm run test:side-chat
npm test
npm run build:renderer
npm run build:electron:production
npm run source:check
npm run side-chat:ui-smoke -- <private-output-directory>
npm run release:check -- <review-app.asar>
```

The preparation command does access native authentication/catalog state but
contains no model-start route. The live packaged harness requires a fresh user
approval, an isolated app profile, a verified official CLI, an explicitly selected
parent and an existing Toki v4 pack copy. It saves review responses only to its
explicit private output; ordinary app use has no response-file sink.

Historical cross-home/custom experiments remain in
[the paginated record](side-chat-paginated.md) and
[the isolated launch record](side-chat-launch-profile.md). They are not a
fallback and are not part of the new build/start/test dependency chain.
