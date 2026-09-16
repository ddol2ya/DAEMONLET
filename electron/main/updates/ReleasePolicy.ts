import { valid, prerelease, gt, lt } from "semver"
import { BUNDLE_ID } from "../../shared/app-identity.mjs"
export const RELEASE_ROOT = "https://github.com/ddol2ya/DAEMONLET/releases"
export const UPDATE_REPOSITORY = { provider: "github" as const, owner: "ddol2ya", repo: "DAEMONLET", private: false }
export type InstallKind = "mac" | "nsis" | "portable" | "unsupported"
export type UpdatePlatform = { platform: string; arch: string; osVersion: string; kind: InstallKind; automatic: boolean; reason?: string }
export type VerifiedRelease = { version: string; file: string; size: number; sha512: string; releaseUrl: string }
export function validateRelease(value: unknown, currentVersion: string, target: UpdatePlatform): VerifiedRelease | null {
  if (!value || typeof value !== "object") throw Error("INVALID_METADATA")
  const info = value as Record<string, any>
  const version = info.version
  if (typeof version !== "string" || valid(version) !== version || prerelease(version) || info.draft === true || info.prerelease === true) throw Error("INVALID_VERSION")
  if (info.tag !== undefined && info.tag !== "v" + version) throw Error("INVALID_METADATA")
  if (!valid(currentVersion)) throw Error("INVALID_VERSION")
  if (!gt(version, currentVersion)) return null
  if (target.kind === "unsupported") throw Error("UNSUPPORTED_INSTALL")
  if (info.daemonlet?.reviewOnly || info.daemonlet?.appId !== BUNDLE_ID || info.daemonlet?.platform !== target.platform || info.daemonlet?.arch !== target.arch || info.daemonlet?.installType !== (target.platform === "darwin" ? "mac" : "nsis")) throw Error("WRONG_PACKAGE")
  if (typeof info.minimumSystemVersion !== "string" || !valid(info.minimumSystemVersion) || !valid(target.osVersion) || lt(target.osVersion, info.minimumSystemVersion)) throw Error("UNSUPPORTED_OS")
  const expected = "Daemonlet-for-Codex-" + version + (target.platform === "darwin" ? "-macOS-arm64.zip" : "-windows-x64-Setup.exe")
  if (!Array.isArray(info.files) || info.files.length !== 1) throw Error("WRONG_PACKAGE")
  const file = info.files[0]
  if (file.url !== expected || info.path !== expected || file.packageInfo || info.packages || info.stagingPercentage !== undefined || info.sha512 !== file.sha512) throw Error("WRONG_PACKAGE")
  if (!Number.isSafeInteger(file.size) || file.size < 1024 * 1024 || file.size > 2 * 1024 ** 3 || typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) || Buffer.from(file.sha512, "base64").length !== 64) throw Error("INVALID_DIGEST")
  return { version, file: expected, size: file.size, sha512: file.sha512, releaseUrl: target.kind === "portable" ? RELEASE_ROOT + "/download/v" + version + "/Daemonlet-for-Codex-" + version + "-windows-x64.zip" : RELEASE_ROOT + "/tag/v" + version }
}
