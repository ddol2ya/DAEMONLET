import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type AttachProbeResult = {
  status: "unsupported" | "inconclusive"
  daemonAvailable: boolean
  twoClientFanOutVerified: false
  backendEnabled: false
  detail: string
}

export async function inspectAttachFeasibility(codexPath: string): Promise<AttachProbeResult> {
  try {
    const { stdout } = await execFileAsync(codexPath, ["app-server", "daemon", "version"], { timeout: 5_000, maxBuffer: 64 * 1024 })
    return {
      status: "inconclusive",
      daemonAvailable: true,
      twoClientFanOutVerified: false,
      backendEnabled: false,
      detail: stdout.trim() ? "daemon responded; an isolated authenticated two-client live turn is still required" : "daemon command responded without version data",
    }
  } catch {
    return {
      status: "unsupported",
      daemonAvailable: false,
      twoClientFanOutVerified: false,
      backendEnabled: false,
      detail: "no running app-server control socket; APP_SERVER_ATTACH remains disabled",
    }
  }
}
