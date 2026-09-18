import { PACK_LIMITS, PACK_RUNTIME, isCharacterId, isPackVersion, isRevision, type CharacterPackManifest } from "./character-pack-contract"

export const PACK_UPDATE_CAPABILITY = "hf-pack-updates-v1"
export const PACK_UPDATE_LIMITS = { descriptorBytes: 2048, feedBytes: 64 * 1024, notes: 2000, checkIntervalMs: 10_000, autoIntervalMs: 24 * 60 * 60_000, metadataTimeoutMs: 30_000, idleTimeoutMs: 30_000, downloadTimeoutMs: 15 * 60_000, redirects: 5 } as const
export type PackUpdateSource = { schemaVersion: 1; provider: "huggingface"; repoType: "dataset"; repoId: string; manifestPath: string }
export type PackUpdateFeed = {
  schemaVersion: 1; packId: string; version: string; minAppVersion: string
  runtime: CharacterPackManifest["runtime"]
  artifact: { path: string; revision: string; bytes: number; sha256: string }; notes: string
}
const invalid = (): never => { throw Error("PACK_UPDATE_METADATA") }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const v = value as Record<string, unknown>
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) return invalid()
  return v
}
export function hfPath(value: unknown, extension: ".json" | ".petchar"): string {
  if (typeof value !== "string" || value.length > 180 || !value.endsWith(extension) || value.split("/").length > 8 || !value.split("/").every(p => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p) && !p.includes(".."))) return invalid()
  return value
}
export function parseUpdateSource(value: unknown): PackUpdateSource {
  const v = object(value, ["schemaVersion", "provider", "repoType", "repoId", "manifestPath"])
  if (new TextEncoder().encode(JSON.stringify(v)).length > PACK_UPDATE_LIMITS.descriptorBytes || v.schemaVersion !== 1 || v.provider !== "huggingface" || v.repoType !== "dataset" || typeof v.repoId !== "string" || v.repoId.length > 193 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(v.repoId) || v.repoId.includes("..")) return invalid()
  return { schemaVersion: 1, provider: "huggingface", repoType: "dataset", repoId: v.repoId, manifestPath: hfPath(v.manifestPath, ".json") }
}
export const updateSourceKey = (id: string, source: PackUpdateSource) => JSON.stringify([id, ...Object.values(parseUpdateSource(source))])
export function parseUpdateFeed(bytes: Uint8Array): PackUpdateFeed {
  if (bytes.byteLength > PACK_UPDATE_LIMITS.feedBytes) return invalid()
  let input: unknown
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { return invalid() }
  const v = object(input, ["schemaVersion", "packId", "version", "minAppVersion", "runtime", "artifact", "notes"])
  if (v.schemaVersion !== 1 || !isCharacterId(v.packId) || !isPackVersion(v.version) || !isPackVersion(v.minAppVersion) || typeof v.notes !== "string" || Array.from(v.notes).length > PACK_UPDATE_LIMITS.notes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.notes)) return invalid()
  const runtime = object(v.runtime, ["engine", "assetApiVersion", "capabilities"])
  // Structurally valid future capabilities produce an app-required state, never "latest".
  if (typeof runtime.engine !== "string" || runtime.engine.length > 32 || !Number.isSafeInteger(runtime.assetApiVersion) || Number(runtime.assetApiVersion) < 1 || !Array.isArray(runtime.capabilities) || runtime.capabilities.length > 32 || runtime.capabilities.some(c => typeof c !== "string" || !/^[a-z0-9-]{1,64}$/.test(c)) || new Set(runtime.capabilities).size !== runtime.capabilities.length) return invalid()
  const a = object(v.artifact, ["path", "revision", "bytes", "sha256"])
  hfPath(a.path, ".petchar")
  if (typeof a.revision !== "string" || !/^[a-f0-9]{40}$/.test(a.revision) || !isRevision(a.sha256) || !Number.isSafeInteger(a.bytes) || Number(a.bytes) < 22 || Number(a.bytes) > PACK_LIMITS.archiveBytes) return invalid()
  return v as unknown as PackUpdateFeed
}
export const supportsUpdateRuntime = (r: PackUpdateFeed["runtime"]) => r.engine === PACK_RUNTIME.engine && r.assetApiVersion === PACK_RUNTIME.assetApiVersion && r.capabilities.every(c => (PACK_RUNTIME.capabilities as readonly string[]).includes(c)) && r.capabilities.includes(PACK_UPDATE_CAPABILITY)
export const sameUpdateRuntime = (a: PackUpdateFeed["runtime"], b: PackUpdateFeed["runtime"]) => a.engine === b.engine && a.assetApiVersion === b.assetApiVersion && JSON.stringify([...a.capabilities].sort()) === JSON.stringify([...b.capabilities].sort())
export type PackUpdatePhase = "source-required" | "idle" | "checking" | "latest" | "available" | "skipped" | "downloading" | "verifying" | "ready" | "applying" | "applied" | "app-required" | "error"
export type PackUpdateState = { packId: string; revision: string; source: PackUpdateSource; phase: PackUpdatePhase; autoCheck: boolean; version?: string; notes?: string; bytes?: number; received?: number; candidateId?: string; error?: string; checkedAt?: number }
export type PackUpdateAction = { action: "check" | "download" | "cancel" | "skip"; packId: string } | { action: "apply"; candidateId: string } | { action: "auto"; packId: string; enabled: boolean }
export const PACK_UPDATE_IPC = { list: "pack-updates.list", act: "pack-updates.act", changed: "pack-updates.changed" } as const
export interface PackUpdateApi { list(): Promise<PackUpdateState[]>; act(value: PackUpdateAction): Promise<void>; onChanged(listener: (states: PackUpdateState[]) => void): () => void }
export const PACK_UPDATE_ERRORS: Record<string, string> = {
  PACK_UPDATE_METADATA: "업데이트 정보 형식이 올바르지 않습니다.", PACK_UPDATE_SOURCE: "업데이트 출처를 확인해 주세요.", PACK_UPDATE_NETWORK: "업데이트 서버에 연결하지 못했습니다.", PACK_UPDATE_HTTP_403: "공개 다운로드 권한이 없습니다.", PACK_UPDATE_HTTP_404: "업데이트 파일을 찾지 못했습니다.", PACK_UPDATE_RATE: "서버 요청 제한입니다. 잠시 후 다시 확인해 주세요.", PACK_UPDATE_REDIRECT: "허용되지 않는 다운로드 주소입니다.", PACK_UPDATE_TIMEOUT: "업데이트 다운로드 시간이 초과되었습니다.", PACK_UPDATE_CHAT_BUSY: "대화 응답이나 캐릭터 전환이 끝난 후 적용해 주세요.",
}
