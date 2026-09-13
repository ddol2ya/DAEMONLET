# Codex hook wire fixtures

These sanitized compatibility fixtures model the command-hook input contracts embedded in local `codex-cli 0.147.0` and corroborated by the official Codex Hooks documentation. They contain placeholder identities and paths only; no transcript or assistant content was copied from a real session.

The installed CLI does not expose its embedded command-input schemas through `app-server generate-json-schema`, so the App Server aggregate hash is not used as a Hook schema hash. Reproducibility is anchored to the installed CLI artifact and the committed fixture bytes:

- installed CLI artifact SHA-256: `19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37`
- `session-end-v0.147.0.json`: `befdd0a066798e2a97badc3a72c71357e698aa432817ee85658c0640a6ff9f0c`
- `stop-null-message-v0.147.0.json`: `898b5b91deb6509ffde55baf1a500d77ec8770e30676efe18182380bc637ad10`

`SessionEnd` deliberately accepts a non-empty future reason and an absent transcript path in addition to the installed 0.147.0 wire. `Stop` keeps the installed required permission mode and nullable assistant-message contract; the message is discarded during validation.

## CLI 0.153.4

`contract-v0.153.4.json` contains the nine complete command-input schemas extracted from the official Apache-2.0-licensed `@openai/codex@0.153.4-darwin-arm64` executable and matching synthetic input fixtures. No actual session or user content appears in them. Its native artifact SHA-256 is `b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3`; the npm wrapper SHA-256 is `61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70`.

The first eight input schemas are structurally identical to those extracted from the earlier 0.147.0 artifact. A matching embedded Interrupt schema was not located in that older artifact; the 0.153.4 Interrupt schema is extracted directly and is not inferred from a version range. Historical evidence is retained as originally recorded. Parser support remains separate from actual CLI/Desktop delivery.

Reproduce the read-only artifact, embedded-schema and fixture checks with:

```bash
node scripts/verify-codex-hook-contract.mjs /absolute/path/to/reviewed/native/codex --output /path/to/new-evidence.json
```

This does not execute the CLI, read a user Home, install hooks or request a model. It refuses a different binary hash and existing output file. It also checks the forwarder's empty response against the eight embedded output schemas. SessionEnd has no embedded output schema and is advisory per the [official event reference](https://learn.chatgpt.com/docs/hooks#sessionend). `codex-hook-contract-01534.test.ts` exercises every fixture through the raw validator, source sanitizer and sanitized ingress boundary.
