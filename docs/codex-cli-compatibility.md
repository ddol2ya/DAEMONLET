# Codex CLI and Hook compatibility

The common connection floor is **official npm CLI 0.154.0 or newer** on macOS
arm64 and Windows x64. This applies to Settings → Codex connection → CLI Hook
setup as well as the usage reader and side chat. There is no per-version upper
allowlist. Legacy explicitly reviewed Hook artifacts remain supported.

The initial implementation expanded only usage/side-chat admission; Hook setup
still used its old exact-artifact registry and wrapper hashes. That omission caused
0.154.0 to display CAPABILITY_CONTRACT_UNKNOWN even though account usage worked.
Discovery and official-file verification now live in `adapter/codex/runtime` and
are shared across all three consumers. npm JS/cmd/PowerShell wrappers are resolved
to the native payload without being executed. Windows PATH discovery checks native
and npm wrapper names; standard npm locations remain available for GUI launches.

## Verification before enabling a Hook plan

1. Resolve and check the installed native file. Reuse a reviewed official digest,
   or verify the exact installed bytes against the official npm archive using the
   fixed HTTPS origin, complete archive integrity and native payload hash/size.
   New npm versions can require an initial download; no file is installed/replaced.
2. Read the official binary's embedded input schemas for the nine observed Hook
   events. Verify required wire fields, types and event identities against the
   compatible parser contract. Additional fields are allowed. Missing/incompatible
   schemas fail closed; version strings alone do not establish Hook capability.
   Verify that an empty JSON response is accepted by the eight output schemas;
   SessionEnd is advisory and has no embedded output schema.
3. Probe only `--version` and `features list`; require the version to match the
   verified artifact and an effective enabled Hook feature. A user config flag is
   not proof when the CLI omits or fails its feature probe.
4. Retain packaged-host/self-test, permanent location, managed-policy, active-task,
   foreign-Hook ownership, preview/explicit apply and Codex's own `/hooks` trust
   boundaries. Discovery never installs Hooks or grants Codex trust.

Schema inspection is cached in memory by the verified native digest. Cancellation
also aborts pending official-file verification. No model request or user Hook/config
write occurs during discovery. Real event delivery and the desktop observation
surface are reported separately from schema compatibility.

Official references: [Hooks](https://learn.chatgpt.com/docs/hooks),
[App Server](https://learn.chatgpt.com/docs/app-server). The minimum-version policy
is Daemonlet's compatibility policy, not a guarantee that all future upstream
protocol changes are compatible. Unknown standalone builds without npm version
metadata still require a known official digest.

Regression coverage includes the real HookSetupDoctor → CodexIntegrationController
→ installation-preview path for verified synthetic 0.154.0, 0.155.0 and 1.0.0,
with no test-only runtime flag in production. It also covers integrity failure,
incompatible schemas, missing/disabled features, version mismatch and cancellation.
Actual 0.154.0 macOS and Windows embedded schema checks are recorded separately in
local candidate evidence. No real-account model calls are needed for these checks.
