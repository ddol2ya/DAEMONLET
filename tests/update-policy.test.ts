import { describe, it, expect } from "vitest"
import { validateRelease, type UpdatePlatform } from "../electron/main/updates/ReleasePolicy"
import { parseUpdateAction } from "../electron/shared/update-contract"
import { BUNDLE_ID } from "../electron/shared/app-identity.mjs"
import { normalizeDesktopSettings } from "../electron/shared/desktop-settings"
const platform: UpdatePlatform = { platform: "darwin", arch: "arm64", osVersion: "26.0.0", kind: "mac", automatic: true }
export const releaseInfo = (version = "0.10.0") => { const file = { url: "Daemonlet-for-Codex-" + version + "-macOS-arm64.zip", size: 1234567, sha512: Buffer.alloc(64, 7).toString("base64") }; return { version, tag: "v" + version, path: file.url, sha512: file.sha512, files: [file], minimumSystemVersion: "22.0.0", daemonlet: { appId: BUNDLE_ID, platform: "darwin", arch: "arm64", installType: "mac" } } }
describe("update release boundary", () => {
  it("compares SemVer numerically and retains an exact official asset", () => expect(validateRelease(releaseInfo(), "0.9.9", platform)?.version).toBe("0.10.0"))
  it.each(["0.9.9", "0.9.8"])("refuses same-version replacement and downgrade %s", version => expect(validateRelease(releaseInfo(version), "0.9.9", platform)).toBeNull())
  it.each(["0.10.0-beta.1", "v0.10.0", "garbage"])("rejects non-stable %s", version => expect(() => validateRelease(releaseInfo(version), "0.9.9", platform)).toThrow())
  it.each(["../payload.zip", "https://evil.test/a.zip", "Daemonlet-creator.zip", "source.zip", "toki.petchar", "Daemonlet-for-Codex-0.10.0-macOS-x64.zip"])("rejects asset %s", file => { const info = releaseInfo(); info.files[0].url = file; info.path = file; expect(() => validateRelease(info, "0.9.9", platform)).toThrow("WRONG_PACKAGE") })
  it("rejects missing or inconsistent identity, digest, size, OS and ambiguous metadata", () => {
    for (const alter of [(x: any) => delete x.daemonlet, (x: any) => x.daemonlet.appId = "other", (x: any) => x.files[0].size = 0, (x: any) => x.files[0].sha512 = "wrong", (x: any) => x.files.push(x.files[0]), (x: any) => x.minimumSystemVersion = "99.0.0", (x: any) => x.tag = "v1.0.0", (x: any) => x.packages = {}, (x: any) => x.draft = true]) { const info = releaseInfo(); alter(info); expect(() => validateRelease(info, "0.9.9", platform)).toThrow() }
  })
  it("defaults automatic checks OFF without resetting explicit OFF, packs or placement", () => {
    const result = normalizeDesktopSettings({ characterId: "toki", sideChatEnabled: false, updateAutoCheck: false, language: "en", scale: 0.8, bubblePlacement: { schemaVersion: 1, mode: "relative", offsetX: -99, offsetY: 72, pivotX: 1, pivotY: 0 } }, () => true).value
    expect(result).toMatchObject({ characterId: "toki", sideChatEnabled: false, updateAutoCheck: false, language: "en", scale: 0.8, bubblePlacement: { mode: "relative", offsetX: -99 } })
    expect(normalizeDesktopSettings({ language: "en" }).value.updateAutoCheck).toBe(false)
  })
  it("only accepts capability IDs, never URLs, paths or commands", () => {
    expect(parseUpdateAction({ action: "check" })).toEqual({ action: "check" })
    for (const value of [{ action: "download", candidateId: "../../evil" }, { action: "check", url: "http://localhost" }, { action: "installAndRestart", candidateId: "d4664dd8-9f04-4919-8a7a-58013f81d6c6", command: "calc" }, [], null]) expect(parseUpdateAction(value)).toBeNull()
  })
})
