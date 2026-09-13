import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { CodexAdapterMode } from "./types.ts"

export type CodexAdapterConfig = {
  mode: CodexAdapterMode
  dataDir: string
  protocolHost: "127.0.0.1"
  protocolPort: number
  hookHost: "127.0.0.1"
  hookPort: number
  staleTtlMs: number
  recoveryTtlMs: number
  codexPath: string
  codexHome: string
}

const port = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`invalid port: ${String(value)}`)
  return parsed
}

const recoveryTtl = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 6 * 60 * 60 * 1_000) {
    throw new Error(`invalid recovery TTL: ${String(value)}`)
  }
  return parsed
}

export function createCodexAdapterConfig(overrides: Partial<CodexAdapterConfig> = {}): CodexAdapterConfig {
  return {
    mode: overrides.mode ?? "HOOK_OBSERVER",
    dataDir: resolve(overrides.dataDir ?? process.env.CODEX_PET_DATA_DIR ?? join(homedir(), ".codex-pet")),
    protocolHost: "127.0.0.1",
    protocolPort: overrides.protocolPort ?? port(process.env.CODEX_PET_PROTOCOL_PORT, 4174),
    hookHost: "127.0.0.1",
    hookPort: overrides.hookPort ?? port(process.env.CODEX_PET_HOOK_PORT, 4175),
    staleTtlMs: overrides.staleTtlMs ?? 6 * 60 * 60 * 1_000,
    recoveryTtlMs: overrides.recoveryTtlMs ?? recoveryTtl(process.env.CODEX_PET_RECOVERY_TTL_MS, 2 * 60 * 1_000),
    codexPath: overrides.codexPath ?? process.env.CODEX_PATH ?? "codex",
    codexHome: resolve(overrides.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")),
  }
}
