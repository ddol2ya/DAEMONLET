import { APP_NAME, PROTOCOL_PORT, HOOK_PORT } from "../shared/app-identity.mjs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { createServer } from "node:net"

/** Windows Desktop connects through IPC, so no external Hook needs fixed ports.
 * Let the OS select free loopback ports instead of colliding with other apps'
 * outbound connections. Explicit operator overrides remain authoritative. */
export async function prepareDesktopAdapterPorts(environment = process.env, platform = process.platform): Promise<void> {
  if (platform !== "win32") return
  const reservations: ReturnType<typeof createServer>[] = []
  try {
    for (const key of ["CODEX_PET_PROTOCOL_PORT", "CODEX_PET_HOOK_PORT"] as const) {
      if (environment[key] !== undefined) continue
      const server = createServer()
      reservations.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Adapter port allocation failed")
      environment[key] = String(address.port)
    }
  } finally {
    await Promise.all(reservations.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  }
}

export type DesktopAdapterRuntimeConfig = {
  protocolHost: "127.0.0.1"
  protocolPort: number
  protocolEndpoint: string
  hookHost: "127.0.0.1"
  hookPort: number
  hookEndpoint: string
  dataDir: string
}

const parsePort = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`invalid desktop adapter port: ${String(value)}`)
  }
  return parsed
}

export function createDesktopAdapterRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DesktopAdapterRuntimeConfig {
  const protocolHost = "127.0.0.1" as const
  const hookHost = "127.0.0.1" as const
  const protocolPort = parsePort(environment.CODEX_PET_PROTOCOL_PORT, PROTOCOL_PORT)
  const hookPort = parsePort(environment.CODEX_PET_HOOK_PORT, HOOK_PORT)
  const requestedDataDir = environment.CODEX_PET_DATA_DIR ?? join(homedir(), `.${APP_NAME.toLowerCase().replaceAll(" ", "-")}`)
  const dataDir = resolve(requestedDataDir)
  if (!isAbsolute(dataDir)) throw new Error("desktop adapter data directory must be absolute")
  return {
    protocolHost,
    protocolPort,
    protocolEndpoint: `ws://${protocolHost}:${protocolPort}/events`,
    hookHost,
    hookPort,
    hookEndpoint: `http://${hookHost}:${hookPort}/hook`,
    dataDir,
  }
}
