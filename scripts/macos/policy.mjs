import { basename, resolve } from "node:path"
import { isSigningTarget } from "./binary.mjs"

import { APP_NAME, BUNDLE_ID } from "../../electron/shared/app-identity.mjs"
export { APP_NAME, BUNDLE_ID }
export const NOTARY_PROFILE = "daemonlet-notary"
export const JIT_ENTITLEMENT = "com.apple.security.cs.allow-jit"
export const AUDIO_INPUT_ENTITLEMENT = "com.apple.security.device.audio-input"
export const isDictationCode = file => /\/native\/DaemonletDictation\.app(?:\/Contents\/MacOS\/DaemonletDictation)?$/.test(file)

export function requireMac(platform = process.platform) {
  if (platform !== "darwin") throw new Error("This explicit signing/notarization command requires macOS. Unsigned builds remain available.")
}

export function selectIdentity(output, requested, expectedTeam) {
  if (!requested?.trim()) throw new Error("MACOS_SIGNING_IDENTITY is required (exact Developer ID Application name or SHA-1 fingerprint).")
  if (!/^[A-Z0-9]{10}$/.test(expectedTeam ?? "")) throw new Error("MACOS_EXPECTED_TEAM_ID is required.")
  const identities = [...output.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"\s*$/gm)]
    .map((match) => ({ fingerprint: match[1].toUpperCase(), name: match[2] }))
  const matches = identities.filter(({ fingerprint, name }) => name === requested || fingerprint === requested.toUpperCase())
  if (matches.length !== 1) throw new Error("Signing identity is missing or ambiguous; no fallback is allowed.")
  const identity = matches[0]
  const team = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(identity.name)?.[1]
  if (!team || team !== expectedTeam) throw new Error("Expected Developer ID Application certificate/team does not match.")
  return { ...identity, team }
}

export function signedForgeConfig(base, identity, platform = process.platform) {
  requireMac(platform)
  if (!/^[A-F0-9]{40}$/.test(identity?.fingerprint ?? "") || !/^[A-Z0-9]{10}$/.test(identity?.team ?? "")) {
    throw new Error("A validated, unambiguous signing identity is required.")
  }
  if (base.packagerConfig.osxSign || base.packagerConfig.osxNotarize) throw new Error("Base packaging config must remain unsigned.")
  return {
    ...base,
    packagerConfig: {
      ...base.packagerConfig,
      osxSign: {
        identity: identity.fingerprint,
        identityValidation: true,
        continueOnError: false,
        strictVerify: true,
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        // osx-sign 2.7.0 discovers generic binary files, including PAK/PNG/ASAR.
        // Those are resources sealed by their enclosing bundle, not individual code.
        ignore: (file) => !isSigningTarget(file),
        optionsForFile: (file) => ({
          // Main/Helper processes run V8. Frameworks and dylibs receive no process entitlements.
          entitlements: resolve(import.meta.dirname, "../../electron/build/entitlements",
            isDictationCode(file) ? "dictation.plist" : file.endsWith(".app") || file.includes("/Contents/MacOS/") ? "jit.plist" : "empty.plist"),
          hardenedRuntime: true,
          // Omitting timestamp uses Apple's secure timestamp server in osx-sign 2.7.0.
        }),
      },
    },
  }
}

export function assertProduction(mode, main, entries) {
  if (mode?.schemaVersion !== 1 || mode.production !== true || mode.setupSmoke !== false) {
    throw new Error("Signed candidates require an explicit production build without setup-smoke.")
  }
  if (["SETUP_SMOKE_ROOT", "PRIVATE_PROMPT_CANARY", "synthetic-setup-session", "SMOKE_BUILD_REQUIRED"].some((marker) => main.includes(marker))) {
    throw new Error("Setup smoke code is present in the production candidate.")
  }
  if (entries.some((entry) => entry.endsWith(".map") || !/^\/?(package\.json$|dist(?:\/|$)|dist-electron(?:\/|$))/.test(entry))) {
    throw new Error("Unexpected ASAR content or development sourcemaps in candidate.")
  }
}

export function parseSignature(display, expected, { root = false, bundleId = BUNDLE_ID } = {}) {
  const field = (key) => display.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]
  if (!display.includes("Authority=Developer ID Application:") || field("TeamIdentifier") !== expected.team) {
    throw new Error("Signed code has an unexpected authority/team.")
  }
  if (!/flags=.*\bruntime\b/.test(display) || !field("Timestamp")) throw new Error("Hardened Runtime and secure timestamp are required.")
  if (root && (field("Identifier") !== bundleId || !/^Info.plist entries=\d+$/m.test(display))) {
    throw new Error("Root signature must bind the expected bundle identifier and Info.plist.")
  }
  const cdhash = field("CDHash")
  if (!/^[a-f0-9]{40}$/i.test(cdhash ?? "")) throw new Error("Missing code directory hash.")
  return { identifier: field("Identifier"), cdhash, runtime: true, timestamp: true }
}

export function assertEntitlements(entitlements, dictation = false) {
  const allowed = dictation ? AUDIO_INPUT_ENTITLEMENT : JIT_ENTITLEMENT
  if (Object.entries(entitlements).some(([key, value]) => key !== allowed || value !== true)) {
    throw new Error("Unexpected signed entitlement for this process role.")
  }
  return Object.keys(entitlements).sort()
}

export function assertUploadApproval(actual, approved) {
  if (!/^[a-f0-9]{64}$/.test(approved ?? "") || actual !== approved) throw new Error("The archive hash does not match explicit upload approval.")
}

export function notaryStatus(value) {
  if (!["In Progress", "Accepted", "Invalid", "Rejected"].includes(value)) throw new Error("Unknown notarization response; status is not success.")
  return value
}

export function assertCanSubmit(state) {
  if (state.status !== "prepared" || state.submissionId || state.submissionAttemptedAt) {
    throw new Error("Submission already attempted. Resume status for the same ID; never blindly resubmit an uncertain upload.")
  }
}

export function publicSummary(manifest, state) {
  // Construct a new allowlisted object. Never redact raw diagnostics into a public artifact.
  return {
    schemaVersion: 1, sourceCommit: manifest.sourceCommit, version: manifest.version,
    appName: APP_NAME, bundleId: BUNDLE_ID, architecture: manifest.architecture,
    payload: Object.fromEntries(["app.asar", "codex/hook-forwarder.mjs", "codex/codex-adapter-worker.cjs"]
      .filter((key) => typeof manifest.payload?.[key] === "string").map((key) => [key, manifest.payload[key]])),
    signedCodeCount: manifest.signedCode?.length,
    signerMatched: manifest.signerMatched === true, runAsNode: manifest.runAsNode,
    status: state?.status ?? "signed-candidate",
    submission: state?.submission ? { sha256: state.submission.sha256, bytes: state.submission.bytes } : null,
    final: state?.final ? { name: basename(state.final.path), sha256: state.final.sha256, bytes: state.final.bytes } : null,
    installed: false,
  }
}
