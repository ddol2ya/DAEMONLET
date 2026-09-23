import type { PackUpdateSource } from "./pack-update-contract"
/** Application-owned data contract, not a third-party model format. */
export const PACK_RUNTIME = { engine: "anime25d", assetApiVersion: 1, capabilities: ["independent-model", "semantic-layer-swap", "local-eye-blink", "mouth-morph", "head-follow", "pose-variants", "pose-dialogue", "side-chat-persona-v1", "hf-pack-updates-v1", "character-chat-v1"] } as const
export const PACK_LIMITS = {
  archiveBytes: 256 * 1024 * 1024, payloadBytes: 384 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024, jsonBytes: 2 * 1024 * 1024, files: 256,
  pathBytes: 180, pathDepth: 8, jsonDepth: 16, jsonNodes: 60_000, arrayLength: 2048,
  canvasSide: 2048, layerCount: 96, layerPixels: 8_000_000, rigPixels: 12_000_000,
  poses: 16, variantPoses: 32, meshVertices: 65_535, storageBytes: 2 * 1024 * 1024 * 1024,
  workerTimeoutMs: 120_000, workerHeapMb: 384, transactionMs: 10 * 60_000,
} as const

export const isCharacterId = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v)
export const isRevision = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)
// v1 deliberately accepts release X.Y.Z only. Prerelease/build semantics are not guessed.
export const isPackVersion = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(v)
export function comparePackVersions(a: string, b: string): number {
  if (!isPackVersion(a) || !isPackVersion(b)) throw new Error("PACK_MANIFEST")
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number)
  return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2]
}
export type PackFile = { path: string; bytes: number; sha256: string }
export type CharacterPackManifest = {
  packFormatVersion: 1; id: string; version: string; name: string; author?: string
  entry: "character.json"; thumbnail?: string; update?: PackUpdateSource
  runtime: { engine: "anime25d"; assetApiVersion: 1; capabilities: string[] }
  profile?: "trial" | "full"; unsupportedReactions?: string[]; files: PackFile[]
}
export type CharacterEntry = {
  id: string; name: string; source: "builtin" | "external"; version: string; revision: string
  manifestUrl: string; status: "ready" | "pending" | "disabled"; error?: string; author?: string
  thumbnailUrl?: string; bytes: number; poseCount: number; previousVersion?: string; update?: PackUpdateSource
  profile?: "trial" | "full"; unsupportedReactions?: string[]
}
export type CharacterSnapshot = { generation: number; entries: CharacterEntry[]; storageBytes: number; storageLimitBytes: number; warning?: string }
export type PackProgress = { phase: "extract" | "files" | "rig"; completed: number; total: number }
export type ImportPreview = {
  token: string; entry: CharacterEntry; kind: "install" | "update" | "installed"
  previousVersion?: string; expiresAt: number; compatible: true
}
export type CharacterSelection = { id: string; revision: string }
export const CHARACTER_IPC = {
  list: "characters.list", choose: "characters.choose-import", commit: "characters.commit-import",
  cancel: "characters.cancel-import", select: "characters.select", remove: "characters.remove",
  rollback: "characters.rollback", changed: "characters.changed", loadFailed: "characters.load-failed", progress: "characters.progress",
} as const
export interface CharacterReadApi {
  list(): Promise<CharacterSnapshot>
  select(selection: CharacterSelection): Promise<void>
  onChanged(listener: (value: CharacterSnapshot) => void): () => void
}
export interface CharacterManageApi extends CharacterReadApi {
  onProgress(listener: (value: PackProgress) => void): () => void
  chooseImport(requestId: string): Promise<ImportPreview | null>
  commitImport(token: string): Promise<CharacterEntry>
  cancelImport(requestId: string): Promise<void>
  remove(selection: CharacterSelection): Promise<boolean>
  rollback(selection: CharacterSelection): Promise<boolean>
}
export const PACK_ERRORS: Record<string, string> = {
  PACK_PERSONA: "캐릭터 페르소나의 형식·참조·권한 규격이 올바르지 않습니다.",
  PACK_INVALID: "손상되었거나 지원하지 않는 캐릭터 팩입니다.",
  PACK_PATH: "팩에 허용되지 않는 파일 경로가 있습니다.",
  PACK_LIMIT: "팩이 파일·메모리·픽셀 제한을 초과합니다.",
  PACK_MANIFEST: "캐릭터 팩의 필수 정보나 파일이 올바르지 않습니다.",
  PACK_INTEGRITY: "팩의 파일이 누락되었거나 해시가 일치하지 않습니다.",
  PACK_SCHEMA: "캐릭터 데이터 또는 리깅 규격이 올바르지 않습니다.",
  PACK_INCOMPATIBLE: "이 팩을 사용하려면 호환되는 앱 업데이트가 필요합니다.",
  PACK_BUILTIN: "기본 제공 캐릭터는 덮어쓰거나 제거할 수 없습니다.",
  PACK_CONFLICT: "같은 버전에 다른 내용이 있습니다. 팩 버전을 높여 주세요.",
  PACK_DOWNGRADE: "이전 버전 팩은 설치할 수 없습니다. 이전 버전 복원을 이용해 주세요.",
  PACK_SPACE: "캐릭터 저장 한도 또는 디스크 여유 공간이 부족합니다.",
  PACK_TIMEOUT: "팩 검증 시간이 초과되었습니다.",
  PACK_CANCELLED: "가져오기가 취소되었습니다.",
  PACK_TRANSACTION: "가져오기 확인이 만료되었거나 목록이 변경되었습니다. 다시 선택해 주세요.",
  PACK_UNAVAILABLE: "이 캐릭터 버전을 사용할 수 없습니다.",
  PACK_BUSY: "캐릭터 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.",
  PACK_LOAD: "새 모델을 표시하지 못했습니다. 이전 캐릭터를 유지합니다.",
  PACK_IO: "캐릭터 저장소를 읽거나 저장하지 못했습니다.",
}
export function packErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  return Object.hasOwn(PACK_ERRORS, message) ? message : "PACK_INVALID"
}
