import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defaultDesktopSettings, normalizeDesktopSettings } from "../electron/shared/desktop-settings"
import { SideChatPreferences, normalizeChatPreferences } from "../electron/main/side-chat/SideChatPreferences"
import { resolveNativeCandidate, sideChatCandidates } from "../electron/main/side-chat/SideChatDiscovery"
import { readOfficialAccountBinding } from "../electron/main/side-chat/SideChatAuth"
import { officialTurnError } from "../electron/main/side-chat/SideChatErrors"
import { isSideChatModelAvailable, SIDE_CHAT_MODEL } from "../electron/main/side-chat/SideChatModelPolicy"
import type { AppServerJsonlClient } from "../adapter/codex/app-server/AppServerJsonlClient"
const roots: string[] = []
const root = async () => { const p = await realpath(await mkdtemp(join(tmpdir(), "chat-product-"))); roots.push(p); return p }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })

it("enables new/missing settings, preserves explicit OFF, and repairs just malformed fields", () => {
  expect(defaultDesktopSettings().sideChatEnabled).toBe(true)
  for (const value of [undefined, true, false, "invalid"]) {
    const saved = { ...defaultDesktopSettings(), language: "en", scale: 1.25, sideChatEnabled: value }
    const normalized = normalizeDesktopSettings(saved).value
    expect(normalized.sideChatEnabled).toBe(value !== false)
    expect(normalized.language).toBe("en"); expect(normalized.scale).toBe(1.25)
  }
})
it("persists consent separately from activation and task integration", async () => {
  const dir = await root(), prefs = new SideChatPreferences(dir)
  await prefs.load(); expect(prefs.get().consentVersion).toBe(0)
  await prefs.save({ consentVersion: 1 }); await prefs.save({ offNoticeSeen: true })
  const next = new SideChatPreferences(dir); await next.load()
  expect(next.get()).toEqual({ version: 1, consentVersion: 1, executable: null, offNoticeSeen: true })
  expect(normalizeChatPreferences({ consentVersion: "bad", executable: "/allowed/file", offNoticeSeen: true })).toMatchObject({ consentVersion: 0, executable: "/allowed/file", offNoticeSeen: true })
})
it("preserves an unreadable preference file instead of granting consent", async () => {
  const dir = await root(); await writeFile(join(dir, "side-chat.json"), "{broken")
  const prefs = new SideChatPreferences(dir); await prefs.load()
  expect(prefs.get().consentVersion).toBe(0)
  await expect(prefs.save({ consentVersion: 1 })).rejects.toThrow("CHAT_SETTINGS_UNREADABLE")
})
it("resolves npm paths with spaces, Korean names and symlinks without running a shim", async () => {
  const dir = await root(), pkg = join(dir, "한글 npm", "@openai/codex"), bin = join(pkg, "bin/codex.js")
  const native = join(pkg, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
  await mkdir(join(pkg, "bin"), { recursive: true }); await mkdir(join(native, ".."), { recursive: true })
  await writeFile(bin, "throw new Error('must never execute')"); await writeFile(native, "fixture native")
  expect(await resolveNativeCandidate(bin, "darwin", "arm64")).toBe(native)
  if (process.platform !== "win32") { const link = join(dir, "codex"); await symlink(bin, link); expect(await resolveNativeCandidate(link, "darwin", "arm64")).toBe(native) }
  await rm(native); await expect(resolveNativeCandidate(bin, "darwin", "arm64")).rejects.toThrow()
})
it("keeps explicit selections authoritative and bounds PATH discovery", () => {
  expect(sideChatCandidates("/chosen/custom", { PATH: "/another" })).toEqual(["/chosen/custom"])
  expect(sideChatCandidates(null, { PATH: Array.from({ length: 100 }, (_, i) => `/tool${i}`).join(":") }, "/fixture", "darwin").length).toBeLessThanOrEqual(48)
})
it.each(["keyring", "auto"])("binds %s through native authenticated workspace metadata, never a stale auth file", async store => {
  const dir = await root(); await writeFile(join(dir, "auth.json"), "stale credential store must not be read")
  let workspace = "a"
  const request = vi.fn(async (method: string) => method === "account/read" ? { account: { type: "chatgpt", email: "same@example.invalid" }, requiresOpenaiAuth: true } : { accountId: workspace, ordinaryUsageAllowed: true })
  const client = { request } as unknown as AppServerJsonlClient
  expect(await readOfficialAccountBinding(client, dir, store)).toMatchObject({ accountId: "a", source: "protocol" })
  workspace = "b"; expect(await readOfficialAccountBinding(client, dir, store)).toMatchObject({ accountId: "b" })
  expect(request.mock.calls.map(([m]) => m)).toEqual(["account/read", "account/rateLimits/read", "account/read", "account/rateLimits/read"])
})
it("does not infer a signed-out or unbound keyring account from a missing auth file", async () => {
  const client = { request: async (method: string) => method === "account/read" ? { account: { type: "chatgpt", email: "same@example.invalid" }, requiresOpenaiAuth: true } : { accountId: "unverified" } } as unknown as AppServerJsonlClient
  await expect(readOfficialAccountBinding(client, await root(), "keyring")).rejects.toThrow("CHAT_AUTH_IDENTITY_UNAVAILABLE")
})
it.each([["usageLimitExceeded", "USAGE_LIMIT"], ["rateLimitExceeded", "RATE_LIMITED"], ["unauthorized", "AUTH_EXPIRED"], [{ httpConnectionFailed: { httpStatusCode: 403 } }, "ACCESS_DENIED"], [{ responseStreamDisconnected: { httpStatusCode: null } }, "OUTCOME_UNKNOWN"]])("classifies structured native failures without leaking server messages", (info, code) => {
  expect(officialTurnError({ codexErrorInfo: info, message: "private path or token" })).toBe(code)
  expect(officialTurnError({ message: "unauthorized private path" })).toBe("TURN_FAILED")
})
it("intersects the live catalog with reviewed models instead of inheriting a costly parent", () => {
  expect(isSideChatModelAvailable([{ model: "unreviewed-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }])).toBe(false)
  expect(isSideChatModelAvailable([{ model: SIDE_CHAT_MODEL.id, supportedReasoningEfforts: [{ reasoningEffort: SIDE_CHAT_MODEL.effort }] }])).toBe(true)
})
