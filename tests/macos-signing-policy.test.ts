import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import base from "../forge.config.mjs"
import { APP_NAME, BUNDLE_ID, JIT_ENTITLEMENT, AUDIO_INPUT_ENTITLEMENT, isDictationCode, entitlementRole, assertCanSubmit, assertEntitlements, assertProduction, assertUploadApproval, notaryStatus, parseSignature, publicSummary, requireMac, selectIdentity, signedForgeConfig } from "../scripts/macos/policy.mjs"

const fingerprint = "A".repeat(40)
const team = "ABCDEFGHIJ"
const name = `Developer ID Application: Test Developer (${team})`
const identity = { fingerprint, team, name }
const listing = `  1) ${fingerprint} "${name}"\n  1 valid identities found\n`
const display = `Identifier=${BUNDLE_ID}\nflags=0x10000(runtime)\nAuthority=${name}\nTeamIdentifier=${team}\nTimestamp=Sep 7, 2026 at 9:00:00 AM\nCDHash=${"a".repeat(40)}\nInfo.plist entries=29\n`

afterEach(() => vi.unstubAllEnvs())

describe("explicit signing policy", () => {
  it("keeps ordinary Forge packaging unsigned even with credential variables present", async () => {
    vi.stubEnv("MACOS_SIGNING_IDENTITY", name)
    vi.stubEnv("MACOS_EXPECTED_TEAM_ID", team)
    vi.stubEnv("MACOS_NOTARY_PROFILE", "a-local-profile")
    const config = (await import("../forge.config.mjs")).default
    expect(config.packagerConfig).not.toHaveProperty("osxSign")
    expect(config.packagerConfig).not.toHaveProperty("osxNotarize")
  })

  it("pins the leaf fingerprint, fails signing errors, and overrides permissive entitlements", () => {
    const config = signedForgeConfig(base, identity, "darwin")
    expect(config.packagerConfig.osxSign).toMatchObject({ identity: fingerprint, continueOnError: false, strictVerify: true, identityValidation: true, preEmbedProvisioningProfile: false })
    expect(config.packagerConfig).not.toHaveProperty("osxNotarize")
    const options = config.packagerConfig.osxSign.optionsForFile
    for (const file of ["/a/Helper (Renderer).app", "/a/Contents/MacOS/Helper"]) {
      expect(options(file)).toMatchObject({ hardenedRuntime: true, entitlements: expect.stringContaining("jit.plist") })
      expect(options(file)).not.toHaveProperty("timestamp")
    }
    expect(options("/a/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework").entitlements).toContain("empty.plist")
    expect(base.packagerConfig).not.toHaveProperty("osxSign")
  })

  it("rejects signed mode on Linux while config imports work", () => {
    expect(() => requireMac("linux")).toThrow("requires macOS")
    expect(() => signedForgeConfig(base, identity, "linux")).toThrow("requires macOS")
  })

  it("selects an exact name or fingerprint, never a substring", () => {
    expect(selectIdentity(listing, name, team)).toEqual(identity)
    expect(selectIdentity(listing, fingerprint.toLowerCase(), team)).toEqual(identity)
    expect(() => selectIdentity(listing, "Developer ID Application", team)).toThrow("missing or ambiguous")
    expect(() => selectIdentity(listing, undefined, team)).toThrow("required")
    expect(() => selectIdentity(listing, name, undefined)).toThrow("required")
  })

  it("rejects multiple matches, wrong certificate kinds, wrong teams, and expired entries", () => {
    expect(() => selectIdentity(listing + listing, name, team)).toThrow("ambiguous")
    const development = `Apple Development: Test Developer (${team})`
    expect(() => selectIdentity(`1) ${fingerprint} "${development}"`, fingerprint, team)).toThrow("Developer ID")
    expect(() => selectIdentity(listing, name, "XXXXXXXXXX")).toThrow("match")
    expect(() => selectIdentity(`1) ${fingerprint} "${name}" (CSSMERR_TP_CERT_EXPIRED)`, fingerprint, team)).toThrow("missing")
    expect(() => selectIdentity(listing, "-", team)).toThrow("missing")
  })
})

describe("production and signature verification", () => {
  const mode = { schemaVersion: 1, production: true, setupSmoke: false }
  const entries = ["/package.json", "/dist", "/dist/pet.html", "/dist-electron/main.cjs"]
  it("allows narrow runtime smoke but rejects setup-smoke and development artifacts", () => {
    expect(() => assertProduction(mode, "ELECTRON_SMOKE_TEST", entries)).not.toThrow()
    expect(() => assertProduction({ ...mode, setupSmoke: true }, "", entries)).toThrow("production")
    expect(() => assertProduction({ ...mode, production: false }, "", entries)).toThrow("production")
    expect(() => assertProduction(mode, "SETUP_SMOKE_ROOT", entries)).toThrow("Setup smoke")
    expect(() => assertProduction(mode, "", [...entries, "/dist-electron/main.cjs.map"])).toThrow("Unexpected")
    expect(() => assertProduction(mode, "", [...entries, "/hooks.json"])).toThrow("Unexpected")
  })
  it("requires bound bundle identity, timestamp, runtime and the expected team", () => {
    expect(parseSignature(display, identity, { root: true })).toMatchObject({ identifier: BUNDLE_ID, runtime: true, timestamp: true })
    for (const changed of [display.replace("runtime", "adhoc"), display.replace(/^Timestamp=.*\n/m, ""), display.replace(BUNDLE_ID, "Electron"), display.replace("Info.plist entries=29", "Info.plist=not bound"), display.replace(`TeamIdentifier=${team}`, "TeamIdentifier=XXXXXXXXXX")]) {
      expect(() => parseSignature(changed, identity, { root: true })).toThrow()
    }
  })
  it("does not permit debug or hardware/library-validation exceptions", () => {
    expect(assertEntitlements({}, "resource")).toEqual([])
    expect(assertEntitlements({ [JIT_ENTITLEMENT]: true })).toEqual([JIT_ENTITLEMENT])
    for (const key of ["com.apple.security.get-task-allow", "com.apple.security.cs.disable-library-validation", "com.apple.security.device.camera", "com.apple.security.device.audio-input"]) {
      expect(() => assertEntitlements({ [key]: true })).toThrow("Unexpected")
    }
  })
})

describe("submission and evidence boundaries", () => {
  it("requires approval of the current archive bytes", () => {
    expect(() => assertUploadApproval("a".repeat(64), "a".repeat(64))).not.toThrow()
    for (const hash of [undefined, "", "b".repeat(64), "approved"]) expect(() => assertUploadApproval("a".repeat(64), hash)).toThrow("approval")
  })
  it("never treats unknown/failed responses as accepted or retries an uncertain submission", () => {
    for (const status of ["In Progress", "Accepted", "Invalid", "Rejected"]) expect(notaryStatus(status)).toBe(status)
    for (const status of ["success", "", undefined]) expect(() => notaryStatus(status)).toThrow("not success")
    expect(() => assertCanSubmit({ status: "prepared" })).not.toThrow()
    for (const state of [{ status: "Submitted" }, { status: "submission-uncertain" }, { status: "prepared", submissionAttemptedAt: "now" }, { status: "prepared", submissionId: "id" }]) expect(() => assertCanSubmit(state)).toThrow("already attempted")
  })
  it("constructs public evidence without private fields or raw nested data", () => {
    const summary = publicSummary({ sourceCommit: "a".repeat(40), signer: { name: "PRIVATE_IDENTITY", team: "PRIVATE_TEAM" }, app: "/PRIVATE_USER/app", raw: "PRIVATE_PASSWORD", payload: {}, architecture: "arm64", version: "0.2.0" },
      { status: "prepared", submissionId: "PRIVATE_ID", profile: "PRIVATE_PROFILE", submission: { path: "/PRIVATE_PATH", sha256: "a".repeat(64), bytes: 123, token: "PRIVATE_TOKEN" } })
    expect(JSON.stringify(summary)).not.toContain("PRIVATE")
    expect(summary).toMatchObject({ installed: false, status: "prepared", submission: { bytes: 123 } })
  })
})


describe("dictation process entitlements", () => {
  it("gives the responsible main app and native helper the required microphone entitlement", () => {
    expect(isDictationCode("/App.app/Contents/Resources/native/DaemonletDictation.app")).toBe(true)
    expect(isDictationCode("/App.app/Contents/Resources/native/DaemonletDictation.app/Contents/MacOS/DaemonletDictation")).toBe(true)
    expect(isDictationCode("/App.app/Contents/MacOS/DaemonletDictation")).toBe(false)
    expect(assertEntitlements({ [AUDIO_INPUT_ENTITLEMENT]: true }, "dictation")).toEqual([AUDIO_INPUT_ENTITLEMENT])
    expect(() => assertEntitlements({ [AUDIO_INPUT_ENTITLEMENT]: true })).toThrow("Unexpected")
    expect(() => assertEntitlements({ [JIT_ENTITLEMENT]: true }, "dictation")).toThrow("Unexpected")
    expect(() => assertEntitlements({}, "dictation")).toThrow("Missing required")
    expect(() => assertEntitlements({ [JIT_ENTITLEMENT]: true }, "main")).toThrow("Missing required")
    expect(assertEntitlements({ [JIT_ENTITLEMENT]: true, [AUDIO_INPUT_ENTITLEMENT]: true }, "main")).toEqual([JIT_ENTITLEMENT, AUDIO_INPUT_ENTITLEMENT].sort())
  })

  it("checks the configured plist contents for each signed code role", () => {
    const app = `/a/${APP_NAME}.app`
    const examples = [
      [app, "main"], [`${app}/Contents/MacOS/${APP_NAME}`, "main"],
      [`${app}/Contents/Resources/native/DaemonletDictation.app`, "dictation"],
      [`${app}/Contents/Resources/native/DaemonletDictation.app/Contents/MacOS/DaemonletDictation`, "dictation"],
      [`${app}/Contents/Frameworks/${APP_NAME} Helper (Renderer).app`, "electron"],
      [`${app}/Contents/Frameworks/${APP_NAME} Helper.app/Contents/MacOS/${APP_NAME} Helper`, "electron"],
      [`${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`, "resource"],
      [`${app}/Contents/Frameworks/libEGL.dylib`, "resource"],
    ]
    const options = signedForgeConfig(base, identity, "darwin").packagerConfig.osxSign.optionsForFile
    for (const [file, role] of examples) {
      expect(entitlementRole(file)).toBe(role)
      const xml = readFileSync(options(file).entitlements, "utf8")
      const keys = [...xml.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map(match => match[1])
      const values = Object.fromEntries(keys.map(key => [key, true]))
      expect(() => assertEntitlements(values, role)).not.toThrow()
      expect(keys.includes(AUDIO_INPUT_ENTITLEMENT)).toBe(role === "main" || role === "dictation")
    }
    for (const role of ["main", "dictation", "electron", "resource"]) {
      expect(() => assertEntitlements({ "com.apple.security.cs.disable-library-validation": true }, role)).toThrow("Unexpected")
    }
  })
})
