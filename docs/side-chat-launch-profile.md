# Side-chat launch profile v2

Validated 2026-09-16 against the official [Codex 0.154.0 release](https://github.com/openai/codex/releases/tag/rust-v0.154.0), source commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`. The installed native macOS arm64 executable hash and profile digest are recorded in [the validation record](side-chat-validation.md). Generated native schemas, raw fixture reports and account evidence remain private. No modified Codex binary is shipped.

## Admission and launch

`SideChatPolicy` resolves the configured CLI or fixed standard installation locations. For npm installations it resolves the package's native executable without executing the JavaScript shim. It checks owner, write permissions, size, executable access and exact native SHA-256 before starting anything. Version text alone never admits a runtime.

`SideChatLaunchProfile` starts `app-server --listen stdio://` in fresh owned directories. HOME, USERPROFILE, CODEX_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, TMPDIR/TMP/TEMP and cwd all point inside that root. PATH contains only standard system executable directories. Parent environment credentials, custom providers, user config, skill files and project configuration are not inherited. stderr is consumed without forwarding content to logs.

The app uses native `configRequirements/read` and `config/read(includeLayers=true)` before and after external-token login. Any managed requirements or nonempty extra active layer fail closed; system and organization enforcement remain in Codex's normal loader. Native typed `ToolsV2` does not return the two tool gates, so their values are checked in the sole owned raw user layer. A missing layer does not pass. The verified config contains:

```toml
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "ephemeral"
[history]
persistence = "none"
[features]
shell_tool = false
view_image = false
shell_snapshot = false
hooks = false
goals = false
apps = false
plugins = false
[tools.experimental_request_user_input]
enabled = false
[tools.update_plan]
enabled = false
[agents]
enabled = false
[otel]
log_user_prompt = false
exporter = "none"
```

MCP servers and custom providers are empty. Each child `turn/start` also carries `environments: []`. The app-owned custom `model_catalog_json` fixes text-only capabilities, disabled shell, null patch type, no experimental tools and no mutable remote collaboration-mode templates. It contains original app instructions, not copied upstream model instructions. An authenticated official catalog discovery **without** this custom catalog must first report `gpt-5.6-luna` and low reasoning. Then the process restarts with the capability ceiling and repeats native policy/auth checks. No model call is used for readiness.

The app reads an existing private Codex ChatGPT access token and uses the official [external-token auth contract](https://learn.chatgpt.com/docs/app-server#auth-endpoints). It never writes or refreshes the original credentials. The refresh callback accepts only an unexpired changed token for the same account, otherwise it fails with `CHAT_AUTH_REQUIRED`. The model service remains responsible for authenticating the token; JWT expiry parsing and `account/read` alone are not model-success evidence.

## Tool generation, handlers and controls

Source paths below are relative to `codex-rs/core/src` in the pinned commit. The [tool registry plan](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/tools/spec_plan.rs) gates handlers before execution. Unrecognized hostile calls return native unsupported-tool feedback. Rejecting client approval requests is only an additional layer.

| Capability | Generation / configuration | Execution handler | Restricted negative / enabled positive |
| --- | --- | --- | --- |
| Shell, file read/write | `tools/spec_plan.rs:1079`; needs environment, ShellTool and enabled model shell | `tools/handlers/shell_spec.rs`, unified exec | No exposed tools, no canary write or secret read / command creates canary and returns synthetic file contents |
| `apply_patch` | `tools/spec_plan.rs:1255`; needs environment and non-null model patch type | `tools/handlers/apply_patch.rs` | Unsupported custom call, no file / valid patch creates canary |
| `view_image` | `tools/spec_plan.rs:1269`; needs environment and Feature::ViewImage | `tools/handlers/view_image.rs` | Unsupported call, no image / valid generated PNG returns image content |
| `request_user_input` | `tools/spec_plan.rs:1158`; `tools.experimental_request_user_input.enabled` | `tools/handlers/request_user_input.rs` | Unsupported call, no client request / plan-mode positive reaches native client request |
| Update plan / agents / web | Update-plan gate, agents disabled, web disabled, no environment | No permitted tool registered in captured child requests | Zero exposure in every captured child request, including compaction; no separate execution positive claimed |
| Apps / plugins | Apps and Plugins feature gates, empty experimental model tools | No permitted tool registered | Zero exposure; no separate account-backed plugin positive claimed |
| Hook / MCP startup | Normal hook trust hash, hooks feature false; owned empty MCP config | Codex native startup | Neither canary at spawn, initialize, thread, turn or fork / normal trusted hook and MCP canaries both run by turn completion |

The four tool positives use a fresh account-free temporary project and the same custom catalog with only tested capabilities enabled. Tool negatives use the production backend and exact app capability catalog. The image positive required a valid PNG: earlier corrupt-fixture failures were retained and are not counted as isolation passes. Hook positives use normal discovery and a trusted hash for the known synthetic command, never a trust bypass. Startup tests deliberately include a disabled synthetic MCP definition to establish its behavior; production has no definitions.

## Policy delivery and final response

Every child turn supplies app-owned developer instructions through the schema-supported `collaborationMode.settings.developer_instructions`. External persona data remains user-role content on **each** question. There is no model warm-up turn or developer injection into the parent. The compiler supplies application rules and treats character descriptions as untrusted style data.

In the native fake-provider probe, first-turn policy copies were 1; after each of two real remote compactions they were 2, with policy and current user-profile content present. Synthetic large retention pressure forced the second compaction. This tests the native reconstruction path rather than assuming one injected message survives. The [native collaboration-mode state](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/context/world_state/collaboration_mode.rs) tracks state changes and rebuilds policy; mutable remote mode templates would take precedence, which is why this profile pins an app-owned catalog.

`SideChatItemCollector` belongs to one ActiveSend and tracks started/completed agent item IDs. Only the matching child/turn is routed to it. Commentary is excluded when a final answer exists. `item/completed` supplies authoritative text; terminal `turn/completed` confirms outcome and optionally provides a validated, deduplicated fallback. Conflicting duplicates, unknown items, malformed output, excessive item count and byte limits have separate regression coverage. No answer lookup scans a child disk transcript.

## Upstream restrictions and small reproductions

Use an absolute native CLI path and **new** private output filenames:

```sh
# Accepted profile: real production backend and native CLI, fake provider, no account.
npm run side-chat:probe -- --codex <native> --output <report.json> --catalog --environments --instructions collaboration-mode --legacyParent --crossHome --compaction
npm run side-chat:probe:tools -- --codex <native> --output <tools.json>
npm run side-chat:probe:startup -- --codex <native> --output <startup.json>

# Expected failures: synthetic upstream diagnostics only (exit 1).
npm run side-chat:probe -- --codex <native> --output <paginated.json> --catalog --environments --instructions collaboration-mode --crossHome --rawParentBoundary
npm run side-chat:probe -- --codex <native> --output <dynamic.json> --catalog --environments --instructions collaboration-mode --legacyParent --crossHome --hostileParent --rawParentBoundary
# Production parent guard: no child created and zero child model requests.
npm run side-chat:probe -- --codex <native> --output <guard.json> --catalog --environments --instructions collaboration-mode --legacyParent --crossHome --hostileParent
```

`--rawParentBoundary` is confined to the account-free script's constructor injection. It supplies the boundary of its own synthetic fixture to expose the native failure; there is no equivalent production setting. Expected-failure reports remain FAIL for end-to-end chat, even when they establish that a guard works. The historical standalone RPC script remains `side-chat:probe:legacy`; it is not the main integration acceptance test.

### Paginated parent across isolated Codex homes — BLOCKED_UPSTREAM

Native `thread/start(historyMode=paginated)` plus a completed synthetic turn succeeds in the source home. Forking its known path/ID/boundary from a new isolated home with `ephemeral=true, excludeTurns=true` returns **RPC -32600, `no rollout found for thread id <synthetic-id>`**, before any child model request.

In [thread_processor.rs](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/request_processors/thread_processor.rs#L4837), `self.thread_store.prepare_fork` uses the receiving process's store. Supplying a path does not bind that paginated store to the external source. The app currently validates only legacy rollouts and rejects paginated parents; it does not copy user databases or run the child inside the user's configuration home.

Minimum upstream proposal: allow the fork preparation path to open an explicitly supplied source paginated store read-only, validate ID and terminal boundary in that store, and keep all child writes/configuration in the destination store. Add cross-store ephemeral-fork tests proving source immutability, complete ordered history and no child persistence. This is a proposed contract change, not an implemented or validated upstream patch.

### Inherited dynamic tools — guarded in the app; upstream clearing needed

A legacy parent seeded with a synthetic `forbidden_parent_tool` exposes it in every child model request even with no environments and the pinned capability catalog. This fails the zero-tools condition. With the real parent reader enabled, the app rejects `PARENT_CAPABILITIES` before fork and makes **zero child model requests**.

[session/mod.rs:721](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/mod.rs#L721) treats an empty dynamic-tool vector as “inherit from conversation history.” Fork has no clear-inheritance contract. Minimum upstream proposal: distinguish absent/inherit from explicit empty/clear in fork params and core session setup; test clearing through fork and compaction without modifying the parent. Until then the app's conservative metadata guard is required.

Neither proposal installs or distributes a forked runtime. Maintaining one would also require rebuild/signing/update ownership, native-binary audit and license preservation; those are outside this change.

## Explicit packaged account QA

The existing `scripts/electron-smoke.mjs` runner accepts the following together: a packaged `ELECTRON_SMOKE_EXECUTABLE`, isolated evidence directories via `ELECTRON_SMOKE_EVIDENCE_DIRECTORY` and `ELECTRON_SMOKE_LIVE_SIDE_CHAT_EVIDENCE`, the selected existing auth home via `ELECTRON_SMOKE_LIVE_AUTH_HOME`, and the exact consent marker `ELECTRON_SMOKE_LIVE_SIDE_CHAT=user-authorized-six-requests`. An optional `ELECTRON_SMOKE_CHARACTER_STORE` supplies an isolated copy of an existing external Toki store. The marker is a manual test invocation guard, not a production bypass or automatic consent mechanism. Running it consumes up to six logical model requests and requires an explicit account-test budget.

This harness creates its own non-sensitive legacy parent in temporary state, then gives that owned parent to the actual Main service's candidate selection. It uses the normal app production connector, not a replacement backend. It does not prove that arbitrary desktop paginated parents can connect. QA responses/screens are explicitly saved to the chosen private directory. Real account evidence was gathered before subsequent test-harness capture synchronization and extraction of the unchanged policy assertion into a unit-tested helper; final source/artifact fingerprints are recorded separately. No more real model calls were made to conceal that distinction.
