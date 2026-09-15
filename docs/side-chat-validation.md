# Character side conversation: implementation and validation

Unreleased implementation. Experimental setting defaults to **OFF**. No runtime is currently admitted by the production policy gate; this is **not release-ready AI chat support**. No public release or automatic merge is part of this work.

## Runtime support (2026-09-15)

Tested: macOS / arm64, Homebrew-resolved `codex-cli 0.153.4`, executable SHA-256 `61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70`. The executable-generated experimental protocol schema was inspected. The probe used new temporary Codex state, a synthetic local parent and a loopback fake Responses provider, with no account credentials or real account model calls. It did not resume, interrupt or modify any user parent, change global config or attach to the user's Codex process.

| Check | Result | Meaning |
| --- | --- | --- |
| Initialize, paginated parent, completed-turn ephemeral fork, response | PASS | Real CLI protocol with synthetic provider |
| `deferGoalContinuation` with `ephemeral` | FAIL | Runtime rejects the combination; it is omitted from the implemented fork request |
| New developer instructions in first fork model request | FAIL | Captured first fork request omitted the unique persona marker |
| Zero exposed tools | FAIL | `request_user_input`, `apply_patch`, `view_image` remained exposed after tested restrictions |
| Parent completed history unchanged by side request | PASS | Before/after parent turn pages matched |
| Stop child while parent remains in progress | PASS | Only child interrupted, synthetic parent stayed in progress |
| SessionStart command hook disabled | PASS | Explicit synthetic hook canary did not run under `features.hooks=false` |
| Ephemeral absent from normal thread list | PASS | Child was not listed |
| No child rollout / child-ID or marker bytes in inspected state files | PASS, scoped | With `features.shell_snapshot=false`; initial profile without this setting created a shell snapshot file |
| Hostile provider canary write absent | Observed | Canary absent, but tool execution was NOT_OBSERVED; this does not establish pre-execution isolation |
| Owned process termination | PASS | Probe's process stopped and its temporary state was removed |
| Actual account character voice/quality | NOT_RUN | Runtime gate failed; zero actual account calls |
| Windows / other CLI builds | NOT_RUN | No native support claim |

The production factory rejects with `CHAT_POLICY_UNENFORCEABLE` **before starting an account-bearing process or reading a parent transcript**. A configuration key, read-only sandbox, approval policy, prompt delimiter, empty dynamic tool list, or post-event process kill is insufficient evidence for chat-only execution. There is no user/pack/UI/environment bypass, alternate API, main-session send fallback or disk-backed fork fallback. The real RPC backend is exercised through an injected synthetic transport; no verified production launch implementation exists yet.

Future admission requires a versioned launch implementation tied to the actual executable and enforced managed policy, pre-start Hook/MCP/plugin isolation, first-request profile delivery, zero executable tools, adversarial probes, and explicit account-based voice review. Do not interpret one successful schema/probe as a production permit. The [official App Server contract](https://learn.chatgpt.com/docs/app-server) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) are reference material; observations above come from the tested executable.

## Implemented behavior

- A dedicated service, RPC backend, window and narrow sender/frame-validated IPC. Parent choice uses opaque handles from verified local metadata; background task selection never silently rebinds a started chat. No project mapping.
- First-send initialization; per-turn structured output; one pending request; request-ID replay protection; child-only stop and owned-process disposal. Owned child IDs are excluded by the adapter before normal registry/activity processing, with a generation-matched worker acknowledgment before sending.
- Actual renderer ready/apply success drives persona changes. During a pending visual change, sends are blocked and old results are held. Failure keeps the old conversation; success increments the epoch, clears old messages and preserves the draft. Unrelated pack installation does not reset chat.
- One window, compact width 380 CSS px and panel initially 420×560; monitor work-area clamping and panel resize. Five-line measurement uses rendered font/width. Long text is preserved and expanded without a model call or automatic window expansion/focus. Preview is at most 120 graphemes, three lines and 4 KiB; invalid previews use a localized signpost.
- Safe text/code/table-source rendering, exact-source copy, no raw HTML, remote media, automatic links or raw JSON/reasoning/tool stream. Korean IME guards, Shift+Enter, explicit send/stop, keyboard focus and scroll retention. Rich Markdown beyond fenced code and table-source blocks is not implemented.
- Display-only fixed-bubble arbitration; the 36-code-point authored-dialogue contract is unchanged. Header exposes separately observed task state. AI expression values are validated and currently no-op; they cannot change task state or invent poses.
- Memory-only 4,000-point / 16,000-byte input, 64-KiB response, 100-message / 2-MiB history limits. Close hides; reset and binding changes start fresh; OFF/quit clears. Uncertain delivery never retries automatically. No native Codex side-UI synchronization.

## Persona and pack evidence

`schemas/character-persona-v1.schema.json` and the shared validator cover strict fields, bounds, controls, Unicode and normalization. Import/export require a matching explicit reference, capability and SHA-256 inventory. Legacy packs resolve neutral profiles; built-in Gpichan uses the same validator without an external pack manifest.

Gpichan's profile is based on `dialogue.ko.json`: formal Korean endings, calm reactions and restrained humor. Examples such as “대기도 업무라면, 성실한 편입니다.” provide direct stylistic evidence. The unknown-progress example is an app-policy adaptation. No fictional background, romance or real memories were inferred. Artwork, rigs and fixed dialogue were unchanged, and the distribution graph includes the persona.

Three user-supplied external variants were independently validated and upgraded, preserving their IDs. The same supplied HTML supported one shared normalized profile; variant filenames did not create three personalities. Only root character/pack metadata changed and one persona file was added. Original/output archive hashes, source section/element evidence, exact unchanged inventories and source interpretation are in private outputs, excluded from Git and app/skill artifacts. No source HTML, original character artwork or external packs are bundled into the default app/public repository. The source archives contain provenance metadata, which was preserved; no new rights grant was inferred.

Persona-only creator commands are executable without ComfyUI/Python/GPU. New-artwork production reuses its already-confirmed profile for dialogue and persona. The independent ZIP includes validator, schema, exporter and upgrade helper; its extracted runtime was tested with no root-repository tool imports. Source/model license review remains distinct from technical readiness.

## Reproducible checks

```sh
npm run typecheck
npm test
npm run test:side-chat
npm run build:renderer
npm run build:electron:production
npm run side-chat:probe -- --codex <absolute-cli> --output <new-private-report.json>
npm run side-chat:ui-smoke -- <private-evidence-directory>
npm run creator:package -- --output <new-private-output-directory>
npm run creator:verify -- <generated-skill.zip>
npm run source:check
npm run release:check -- <packaged-app.asar>
```

The UI smoke launches isolated Electron with a synthetic backend, tests short/long Korean and English, code/table/emoji, IME Enter/Escape, source copy, task-state updates, draft/scroll retention, hide/show, zoom and OFF. It is not a model-quality test. The app's existing `scripts/electron-smoke.mjs` additionally accepts `ELECTRON_SMOKE_SIDE_CHAT_EVIDENCE` to check the real production gate/UI and `ELECTRON_SMOKE_SIDE_CHAT_PACKS` plus an isolated `ELECTRON_SMOKE_CHARACTER_STORE` to inspect imported packs. Use `ELECTRON_SMOKE_EXECUTABLE` for the actual packaged binary. These checks use temporary app/Codex profiles and do not install over the user's app or packs.

Local socket tests need permission to bind loopback. The initial sandbox run failed with EPERM; it is not counted as a passing regression run. Native packaging, UI and creator extraction evidence are recorded separately in the final private validation summary. Retain the source fingerprint with each build; later documentation-only commits are not identical build fingerprints.

## Executed deterministic and artifact checks

- TypeScript: PASS. Full Vitest run: **148 files, 1,482 passed, 5 skipped**. Side-chat/persona subset: **39 passed**. No skipped test is reported as executed.
- Renderer and production Electron builds: PASS; known existing `ag-psd` browser externalization, upstream CommonJS and bundle-size warnings remain. Source/private-data and packaged asset/license checks: PASS.
- Real Electron UI with synthetic backend: PASS for compact/panel, original-source copy, IME Enter/Escape, 150% zoom, language changes, task-state/draft/scroll preservation and disable cleanup. Captures were inspected. This is separate from the failed real runtime gate.
- User-provided external pack variants: full original/output validation, byte comparison, isolated original-install/update/restart/rollback, actual renderer selection and head/torso click-reaction smoke: PASS within those scopes. Geometry was derived from each pack's authored interaction areas. All-pose and real-model voice reviews remain unrun.
- Complete creator ZIP generation and isolated extraction: PASS. Extracted `validate-persona`, `upgrade-persona`, exporter, Python helper import and renderer-source bundle ran successfully. The independent runtime did not use root-repository tool imports; separate fixture artwork was supplied by the verifier. No GPU inference ran.
- An initial native smoke raced the existing settings-save debounce after activation; a bounded wait for the same persisted-state assertion replaces the fixed-time assumption. Connection-absent visual trials are not counted as passing interaction trials; the final pack smoke supplies the existing synthetic presence fixture.

## Remaining acceptance conditions

Real account persona quality, admitted production runtime, Windows execution, physical monitor removal and exhaustive every-pose review are not established by the deterministic tests. A draft PR can be reviewed while these remain explicit blockers for enabling real chat or releasing it.
