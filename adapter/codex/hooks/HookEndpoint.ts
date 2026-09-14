import { randomUUID } from "node:crypto"
import { lstat, realpath, writeFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"

/** A stable locator for Windows' per-launch loopback port, not a credential. */
export async function publishHookEndpoint(directory: string, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_HOOK_ENDPOINT")
  const root = await realpath(directory)
  if (root !== directory || (await lstat(directory)).isSymbolicLink()) throw new Error("UNSAFE_DIRECTORY")
  const target = join(root, "hook-endpoint"), temporary = join(root, `.hook-endpoint-${randomUUID()}`)
  try {
    const old = await lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error })
    if (old && (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1)) throw new Error("UNSAFE_FILE")
    await writeFile(temporary, `http://127.0.0.1:${port}/hook\n`, { mode: 0o600, flag: "wx" })
    await rename(temporary, target)
  } finally { await rm(temporary, { force: true }) }
}
