import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { crc32 } from "node:zlib"
import { initializeCanvas, writePsd } from "ag-psd"
import { PACK_RUNTIME } from "../../electron/shared/character-pack-contract"
import { sha256 } from "../../electron/main/CharacterPackAssets"

export function tinyPsd(color = 180): Buffer {
  initializeCanvas(() => { throw new Error("no canvas") }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }))
  const layer = (name: string, left: number, top: number, width: number, height: number) => ({ name, left, top, right: left + width, bottom: top + height, imageData: { width, height, data: new Uint8ClampedArray(Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 255 : color)) } })
  return Buffer.from(writePsd({ width: 64, height: 96, children: [layer("back hair", 10, 4, 44, 54), layer("topwear", 8, 52, 48, 40), layer("face", 16, 15, 32, 40), layer("mouth", 29, 42, 6, 3), layer("eyewhite", 21, 28, 22, 7), layer("irides", 24, 28, 16, 7), layer("eyelash", 20, 27, 24, 3), layer("front hair", 12, 4, 40, 20)] }, { generateThumbnail: false }))
}
export type ZipEntry = { path: string; data: Buffer; mode?: number; flags?: number; method?: number; size?: number }
/** Deliberately low-level test writer: supports malicious names other writers reject. */
export function rawZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.path), local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.flags ?? 0x800, 6); local.writeUInt16LE(e.method ?? 0, 8)
    local.writeUInt32LE(crc32(e.data), 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.size ?? e.data.length, 22); local.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(e.flags ?? 0x800, 8); central.writeUInt16LE(e.method ?? 0, 10)
    central.writeUInt32LE(crc32(e.data), 16); central.writeUInt32LE(e.data.length, 20); central.writeUInt32LE(e.size ?? e.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42)
    locals.push(local, name, e.data); centrals.push(central, name); offset += local.length + name.length + e.data.length
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
export function packFiles(options: { id?: string; version?: string; color?: number; extra?: Record<string, unknown> } = {}): ZipEntry[] {
  const character = { schemaVersion: 1, id: options.id ?? "fresh-character", label: "새 캐릭터", base: { source: "source.png", psd: "model.psd", overrides: "rig.json" }, poses: [] }
  const entries = [
    { path: "character.json", data: Buffer.from(JSON.stringify(character)) },
    { path: "source.png", data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1MAAAAASUVORK5CYII=", "base64") },
    { path: "model.psd", data: tinyPsd(options.color) },
    { path: "rig.json", data: Buffer.from(JSON.stringify({ cleanupThresholds: { face: 1, topwear: 1, eyewhite: 1, irides: 1, eyelash: 1 } })) },
  ]
  const manifest = { packFormatVersion: 1, id: character.id, name: character.label, entry: "character.json", version: options.version ?? "1.0.0", runtime: { ...PACK_RUNTIME, capabilities: PACK_RUNTIME.capabilities.filter(c => c !== "side-chat-persona-v1" && c !== "hf-pack-updates-v1") }, files: entries.map(e => ({ path: e.path, bytes: e.data.length, sha256: sha256(e.data) })), ...options.extra }
  return [{ path: "pack.json", data: Buffer.from(JSON.stringify(manifest)) }, ...entries]
}
export async function writePack(root: string, options: Parameters<typeof packFiles>[0] = {}) {
  await mkdir(root, { recursive: true })
  const path = join(root, `${options.id ?? "fresh"}-${options.version ?? "1.0.0"}-${options.color ?? 180}.petchar`)
  await writeFile(path, rawZip(packFiles(options))); return path
}
export async function builtinFixture(root: string) {
  await mkdir(join(root, "gpichan"), { recursive: true })
  await writeFile(join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, characters: ["gpichan/character.json"] }))
  await writeFile(join(root, "gpichan/character.json"), JSON.stringify({ schemaVersion: 1, id: "gpichan", label: "지피쨩", poses: [] }))
  return root
}
export async function writePayload(root: string, entries = packFiles()) { for (const e of entries) { await mkdir(dirname(join(root, e.path)), { recursive: true }); await writeFile(join(root, e.path), e.data) } return root }
