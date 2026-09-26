import { spawn } from "node:child_process"
import { AppServerJsonlClient } from "../../../adapter/codex/app-server/AppServerJsonlClient"

/** Main-only process primitive. Callers supply reviewed args; no renderer RPC or
 * setting can pass commands here. Terminate only the handle created by this call. */
export function startChatProcess(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  child.stderr.resume()
  // The client detaches on cancellation; absorb late pipe errors until the
  // owned child finishes closing. These streams never outlive that child.
  child.stdout.on("error", () => {})
  child.stdin.on("error", () => {})
  const client = new AppServerJsonlClient({ readable: child.stdout, writable: child.stdin })
  child.once("error", () => client.close(new Error("SESSION_LOST")))
  let ended = false, stopping: Promise<void> | null = null
  child.once("close", () => { ended = true; client.close(new Error("SESSION_LOST")) })
  return { client, stop: () => stopping ??= new Promise<void>(resolve => {
    client.close()
    if (ended || !child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
    child.once("close", () => { clearTimeout(timer); resolve() })
    child.kill("SIGTERM")
  }) }
}
