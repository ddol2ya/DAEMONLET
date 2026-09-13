import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { filePathForAppUrl } from "../electron/shared/app-protocol-path"

const root = "/application/dist"

describe("pet app protocol path", () => {
  it("maps only the app host and known root paths under dist", () => {
    expect(filePathForAppUrl("pet://app/pet.html", root)).toBe(resolve(root, "pet.html"))
    expect(filePathForAppUrl("pet://app/index.html", root)).toBe(resolve(root, "index.html"))
    expect(filePathForAppUrl("pet://app/assets/pet.js", root)).toBe(resolve(root, "assets/pet.js"))
    expect(filePathForAppUrl("pet://other/pet.html", root)).toBeNull()
  })

  it.each([
    "pet://app/../etc/passwd",
    "pet://app/%2e%2e/etc/passwd",
    "pet://app/%252e%252e/etc/passwd",
    "pet://app/%2fetc/passwd",
    "pet://app//etc/passwd",
    "pet://app/C:/Windows/system.ini",
    "pet://app/C:%5cWindows%5csystem.ini",
    "pet://app/%00pet.html",
    "file:///etc/passwd",
  ])("rejects traversal and absolute path %s", (url) => expect(filePathForAppUrl(url, root)).toBeNull())
})
