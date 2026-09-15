# Character side conversation: implementation and validation

Unreleased implementation; the experimental setting defaults to **OFF**. One production combination has passed real account testing. No public release or automatic merge is part of this work.

## Runtime support (2026-09-16)

| Component | Admitted combination |
| --- | --- |
| Host | macOS / arm64 |
| Codex CLI | Official stable **0.154.0**, installed with explicit user authorization |
| Native executable SHA-256 | `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc` |
| Model | `gpt-5.6-luna`, low reasoning; must appear in the authenticated official `model/list` before the app pins its capability catalog |
| Launch profile | Version 2; digest `1f6ae3ea160b0b1f5742903abe61f464df66156beafe5e8671ed5b52d6623523` |
| Parent | Selected local legacy rollout, last durable terminal turn, **no inherited dynamic tools** |
| Authentication | Official in-memory `chatgptAuthTokens`, brokered from an existing unexpired Codex ChatGPT login; no OAuth refresh or credential-file writes |
| Configuration | Fresh app-owned HOME/CODEX_HOME/cwd/temp; sole nonempty owned config layer; managed requirements cause an explicit block |

The desktop-bundled `0.154.0-alpha.6.2`, other hashes/versions, Windows and other architectures are not admitted. The global npm CLI was updated as explicitly requested; the desktop CLI, PATH and installed Daemonlet app were not replaced.

The production factory now returns a real authenticated connection after static binary checks, native configuration reflection and model discovery. No model canary runs when opening the window or toggling the setting. The first explicit send creates the ephemeral child. Candidate test connections remain constructor-only test dependencies; renderer, packs and ordinary environment settings cannot select them.

See [the launch profile, tool controls and upstream limitations](side-chat-launch-profile.md) for exact settings, source locations and reproductions. Paginated parents remain **BLOCKED_UPSTREAM** for the isolated cross-home path; parents with dynamic tools are blocked before fork. This is a deliberately limited working combination, not universal desktop-task support.

### Evidence levels

| Check | Result | Scope |
| --- | --- | --- |
| Production service → JSONL → real CLI → fake provider → service originals | PASS | Exact short Korean, long/code and commentary/final answers; three child turns |
| Developer policy and user-role persona | PASS | First turn, continuation, two actual native remote compactions with synthetic retention pressure; policy present after both |
| Zero tools / hostile execution | PASS | All child model requests expose zero tools. Four accepted hostile tool-call shapes reject execution; matching enabled controls actually execute |
| Startup Hook / MCP controls | PASS | Trusted synthetic hook and MCP execute in positive control; neither executes under restrictions at spawn/initialize/thread/turn/fork checkpoints |
| Child history / parent preservation | PASS, scoped | No child ID or unique response bytes in inspected fixture state; selected parent history unchanged |
| Production packaged app, official ChatGPT account | PASS | Gpichan short + follow-up/long, exact copy, external Toki switch/response, child stop while parent is running |
| Regression UI | PASS | Existing F1/F2/F3 native synthetic UI checks retained; separate from account validation |
| Windows live CLI / native UI | NOT_RUN | CI is not runtime admission |

### Actual account request accounting

The user authorized an isolated non-sensitive parent and finally **seven logical `turn/start` attempts including failures**. The first attempt used retired `gpt-5.4`; the parent failed and no character answer was produced. Its initial harness did not retain the provider error, so an exact original RPC error is unavailable. The official model list excluded it and the [official retirement notice](https://learn.chatgpt.com/docs/models#deprecated-codex-models) gives August 31, 2026 for Codex ChatGPT sign-in support. It is not registered in the new profile.

The remaining six attempts on `gpt-5.6-luna` produced one completed parent seed, **three completed character answers** (Gpichan twice, Toki once), one confirmed child stop and a concurrent parent turn whose stop was requested separately by its QA owner. Before the child stop the parent was `inProgress`; after it the parent was not interrupted. No subsequent model request was made. These are logical API attempts, not a measured billing/HTTP retry count.

The actual packaged path used the app's service, production connector, validated IPC and mounted renderer. Long expansion and copy made zero additional model requests and preserved the source exactly. Real parent history was unchanged by the first two child turns. Toki selection advanced the epoch and removed old chat messages. The short Gpichan screenshot was captured before its renderer update and is **not visual proof of that answer**; the recorded service response, long-panel and Toki rendered captures provide their respective evidence. Future QA waits for renderer content before capture. Non-sensitive response bodies/screens remain private, outside Git.

### Earlier runtime investigation (historical)

CLI 0.153.4 exposed tools and omitted new first-fork developer instructions in the earlier standalone RPC probe. The earlier hash `61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70` identified the npm **JavaScript wrapper**, not the native executable; it must not be used as native admission evidence. Those failures remain historical observations. The current 0.154.0 profile uses verified native bytes, per-turn collaboration-mode developer instructions and separately proven execution gates.

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
npm run side-chat:probe -- --codex <absolute-native-cli> --output <new-private-report.json> --catalog --environments --instructions collaboration-mode --legacyParent --crossHome --compaction
npm run side-chat:probe:tools -- --codex <absolute-native-cli> --output <new-private-report.json>
npm run side-chat:probe:startup -- --codex <absolute-native-cli> --output <new-private-report.json>
npm run side-chat:ui-smoke -- <private-evidence-directory>
npm run creator:package -- --output <new-private-output-directory>
npm run creator:verify -- <generated-skill.zip>
npm run source:check
npm run release:check -- <packaged-app.asar>
```

The UI smoke launches isolated Electron with a synthetic backend, tests short/long Korean and English, code/table/emoji, IME Enter/Escape, source copy, task-state updates, draft/scroll retention, hide/show, zoom and OFF. It is not a model-quality test. The app's existing `scripts/electron-smoke.mjs` additionally accepts `ELECTRON_SMOKE_SIDE_CHAT_EVIDENCE` to check the real production gate/UI and `ELECTRON_SMOKE_SIDE_CHAT_PACKS` plus an isolated `ELECTRON_SMOKE_CHARACTER_STORE` to inspect imported packs. Use `ELECTRON_SMOKE_EXECUTABLE` for the actual packaged binary. These checks use temporary app/Codex profiles and do not install over the user's app or packs.

Local socket tests need permission to bind loopback. The initial sandbox run failed with EPERM; it is not counted as a passing regression run. Native packaging, UI and creator extraction evidence are recorded separately in the final private validation summary. Retain the source fingerprint with each build; later documentation-only commits are not identical build fingerprints.

## Initial deterministic and artifact checks (2026-09-15)

- TypeScript: PASS. Full Vitest run: **148 files, 1,482 passed, 5 skipped**. Side-chat/persona subset: **39 passed**. No skipped test is reported as executed.
- Renderer and production Electron builds: PASS; known existing `ag-psd` browser externalization, upstream CommonJS and bundle-size warnings remain. Source/private-data and packaged asset/license checks: PASS.
- Real Electron UI with synthetic backend: PASS for compact/panel, original-source copy, IME Enter/Escape, 150% zoom, language changes, task-state/draft/scroll preservation and disable cleanup. Captures were inspected. This is separate from the failed real runtime gate.
- User-provided external pack variants: full original/output validation, byte comparison, isolated original-install/update/restart/rollback, actual renderer selection and head/torso click-reaction smoke: PASS within those scopes. Geometry was derived from each pack's authored interaction areas. All-pose and real-model voice reviews remain unrun.
- Complete creator ZIP generation and isolated extraction: PASS. Extracted `validate-persona`, `upgrade-persona`, exporter, Python helper import and renderer-source bundle ran successfully. The independent runtime did not use root-repository tool imports; separate fixture artwork was supplied by the verifier. No GPU inference ran.
- An initial native smoke raced the existing settings-save debounce after activation; a bounded wait for the same persisted-state assertion replaces the fixed-time assumption. Connection-absent visual trials are not counted as passing interaction trials; the final pack smoke supplies the existing synthetic presence fixture.

## PR #17 review corrections (2026-09-16)

The review's three races were reproduced with imports of the production classes. Before fixes, the new coordinator/backend cases failed eight assertions/cases and the five new draft-service cases failed. The supplied standalone reproduction was reference material, not a replacement test implementation.

- **F1 — bubble lifetime:** chat suppresses display permissions while valid Pet epoch/sequence, geometry, availability and hidden reports still update the coordinator. Expiration clears speech and releases occupation while chat remains open; hiding chat does not require another Pet report to restore activity. Denied preparation cannot cancel an expired line's release timer; latest shown/exiting reports retain occupation while suppressing permission. Pending permission and interaction-lock behavior remain covered.
- **F2 — RPC ownership:** each send owns its resolver, timer, turn ID, connection and backend generation. Start/interrupt continuations and timeouts check that exact active request. Tests use different A/B turn IDs and manually deferred RPC success/failure, including close/reopen with the same child ID. A late response cannot finish B or close B's connection; parent turns are never sent to or interrupted.
- **F3 — draft acceptance:** `send`/`draft` IPC carries a monotonic `draftRevision`. Main records an explicit `{requestId, draftRevision}` receipt when handing a message to the backend. This is app acceptance, not proof of server delivery or a successful answer. The renderer clears only the submitted revision; editing away and back to identical text still counts as a newer draft. Main ignores delayed older draft writes. Open failures keep the latest draft, and unknown delivery remains an error with no retry.

Executed for this correction:

- `npm run typecheck`: PASS. Full suite: **148 files, 1,498 passed, 5 skipped**. `npm run test:side-chat`: **50 passed**. Extended side-chat/persona/bubble/IPC/window selection: **76 passed**.
- Renderer and production Electron builds: PASS. Source/private-data check: PASS. The existing build warnings remain.
- Native macOS arm64 Electron smoke: PASS. The mounted chat renderer exercised last-character edit then Enter before debounce, repeated Enter, new text during deferred preparation, identical text at a newer revision, predispatch failure, composition start/end, 4,000-character limit, hide/show and unknown-outcome replay blocking. Existing compact/panel, copy, language, 150% zoom, draft/scroll and OFF checks also passed.
- Bubble smoke: three open/expire/hide cycles passed through the actual `CharacterDialogueController`, `useBubblePresentation`, sandboxed Pet preload, validated IPC and native speech/activity windows. A small test-only Pet fixture supplies a synthetic cue and stable geometry. It does not test artwork, pose transitions or a live Codex connection. Both native bubbles stayed hidden during chat, and the task bubble returned after expiry without a further Pet event. Captured quick-send and returned-bubble screens were inspected.

The synthetic UI backend made seven fixture sends and zero account calls. These corrections do not change `SideChatPolicy`, admit a runtime, enable the default setting, regenerate character art, or repeat the earlier external-pack/creator/runtime-probe validation. The existing private outputs remain separate from this review's new evidence.

## Current deterministic checks (2026-09-16)

- `npm run typecheck`: PASS.
- Full Vitest: **150 files, 1,527 passed, 5 skipped**; side-chat/persona subset: **79 passed**.
- New native-policy reflection regressions reject changed shell/image/input/plan/web/MCP/provider/model/catalog, missing/extra config layers and managed requirements. File/auth guards reject unsupported parent metadata, external paths, redirects, excessive records, expired/non-ChatGPT credentials and unsafe file permissions.
- Source/private-data check: **669 files, 49 runtime assets, no failures**. Original art, rigs and external pack bytes were not edited for this follow-up.
- Native synthetic UI smoke: PASS for the retained F1/F2/F3 cases and existing layout/copy/IME/language/zoom behavior. Separate actual-account packaged evidence is described above.

## Remaining limits

Live success is limited to the registered host/runtime/model/parent combination and three inspected character answers. Exhaustive voice quality, physical monitor removal, every-pose review and Windows live execution are **NOT_RUN**. Paginated/dynamic-tool parent limitations are described separately above. CI cannot establish those native capabilities. The prior pack/creator evidence remains historical; this follow-up does not regenerate those assets.
