import { afterEach, expect, it } from "vitest"
import { mkdtemp, writeFile, rm, chmod, symlink, link } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readChatAuthIdentity } from "../electron/main/side-chat/SideChatAuth"
import { inspectSideChatExecutable } from "../electron/main/side-chat/SideChatPolicy"
const roots: string[] = []
const home = async () => { const root = await mkdtemp(join(tmpdir(), "chat-auth-test-")); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it("binds a stable account across token rotation and distinguishes another workspace", async () => {
  const root = await home(), file = join(root, "auth.json")
  for (const [account, token] of [["a", "fixture-one"], ["a", "fixture-two"], ["b", "fixture-two"]]) {
    await writeFile(file, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: account, access_token: token } }), { mode: 0o600 })
    expect(await readChatAuthIdentity(root)).toBe(account)
  }
})
it("rejects missing, malformed, non-ChatGPT, oversized and linked credentials", async () => {
  const root = await home(), file = join(root, "auth.json")
  await expect(readChatAuthIdentity(root)).rejects.toThrow("CHAT_AUTH_REQUIRED")
  for (const value of ["{", JSON.stringify({ auth_mode: "apiKey" }), "x".repeat(65537)]) {
    await writeFile(file, value, { mode: 0o600 }); await expect(readChatAuthIdentity(root)).rejects.toThrow("CHAT_AUTH_REQUIRED")
  }
  await rm(file); const source = join(root, "source")
  await writeFile(source, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "a" } }), { mode: 0o600 })
  await link(source, file); await expect(readChatAuthIdentity(root)).rejects.toThrow("CHAT_AUTH_REQUIRED")
})
it.skipIf(process.platform === "win32")("rejects shared and symlink credential stores", async () => {
  const root = await home(), file = join(root, "auth.json")
  await writeFile(file, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "a" } }), { mode: 0o600 })
  await chmod(file, 0o644); await expect(readChatAuthIdentity(root)).rejects.toThrow("CHAT_AUTH_REQUIRED")
  await rm(file); await symlink(join(root, "missing"), file)
  await expect(readChatAuthIdentity(root)).rejects.toThrow("CHAT_AUTH_REQUIRED")
})
it("does not execute an unrecognized candidate", async () => {
  const root = await home(), file = join(root, "codex")
  await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  await expect(inspectSideChatExecutable(file)).rejects.toThrow(/CHAT_RUNTIME_|CHAT_PLATFORM_UNVERIFIED/)
})
