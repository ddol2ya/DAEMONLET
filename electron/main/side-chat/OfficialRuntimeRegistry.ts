/** Reviewed release artifacts, never fetched or extended at runtime. An unknown
 * version is discoverable but cannot start a companion process. */
export const OFFICIAL_RUNTIME_REGISTRY = [{
  version: "0.154.0", platform: "darwin", arch: "arm64", kind: "official",
  executableSha256: "4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc",
  executableBytes: 222655232,
  source: "https://registry.npmjs.org/@openai/codex/0.154.0-darwin-arm64",
  packageIntegrity: "sha512-HP/vJCH/t2hB9Kg6hotN9UglClJ6/z584fal5lEP14C9gNAgAQS4/kTQC7l5V+BA3TqwDPwINSjul28cX8AYXg==",
  sourceCommit: "6b9826e3aa83b1a5947db50f4332cb9c65f1b340",
  parentContract: "official-same-home", permissionContract: "readonly-project-companion-v1",
  verifiedHost: "macOS 27 arm64", credentials: ["file", "keyring-with-protocol-identity", "auto-with-protocol-identity"],
}, {
  version: "0.154.0", platform: "win32", arch: "x64", kind: "official",
  executableSha256: "be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde",
  executableBytes: 298169136,
  source: "https://registry.npmjs.org/@openai/codex/0.154.0-win32-x64",
  packageIntegrity: "sha512-Stg2KEJPIKVqPPR1wCverGOR4ey3RR3cvakR07w7FNKQUMzmHaOZomRsP2bR1qOT/67yHsks9rB+MCMfIWXcRA==",
  sourceCommit: "6b9826e3aa83b1a5947db50f4332cb9c65f1b340",
  parentContract: "official-same-home", permissionContract: "readonly-project-companion-v1",
  verifiedHost: "Windows x64", credentials: ["file"],
}] as const
