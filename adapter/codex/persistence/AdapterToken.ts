import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function loadOrCreateAdapterToken(dataDir: string): Promise<{ token: string; path: string }> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(dataDir, 0o700)
  const path = join(dataDir, "adapter-token")
  try {
    const token = (await readFile(path, "utf8")).trim()
    if (Buffer.from(token, "base64url").byteLength < 32) throw new Error("adapter token is too short")
    if (process.platform !== "win32") await chmod(path, 0o600)
    return { token, path }
  } catch (error) {
    if (error instanceof Error && error.message === "adapter token is too short") throw error
    const token = randomBytes(32).toString("base64url")
    await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" }).catch(async (writeError: unknown) => {
      if (writeError && typeof writeError === "object" && "code" in writeError && writeError.code === "EEXIST") return
      throw writeError
    })
    const actual = (await readFile(path, "utf8")).trim()
    if (process.platform !== "win32") await chmod(path, 0o600)
    if (Buffer.from(actual, "base64url").byteLength < 32) throw new Error("adapter token is too short")
    return { token: actual, path }
  }
}
