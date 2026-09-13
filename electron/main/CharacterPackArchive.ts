import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { openPromise } from "yauzl"
import { crc32 } from "node:zlib"
import { PACK_LIMITS } from "../shared/character-pack-contract"
import { validatePackPath } from "../shared/character-pack-path"
import { isPayloadPath, validatePackDirectory } from "./CharacterPackAssets"

/** One entry/stream at a time; neither archive nor inflated payload is buffered in Main. */
export async function extractCharacterPack(source: string, transactionRoot: string) {
  const size = (await stat(source)).size
  if (size > PACK_LIMITS.archiveBytes || size < 22) throw new Error("PACK_LIMIT")
  const frozen = join(transactionRoot, "archive.zip"), payload = join(transactionRoot, "payload")
  let copied = 0
  await pipeline(createReadStream(source), new Transform({ transform(chunk: Buffer, _encoding, callback) {
    copied += chunk.length
    callback(copied > PACK_LIMITS.archiveBytes ? new Error("PACK_LIMIT") : null, chunk)
  } }), createWriteStream(frozen, { flags: "wx", mode: 0o600 }))
  if (copied !== size) throw new Error("PACK_INTEGRITY")
  await mkdir(payload, { mode: 0o700 })
  const zip = await openPromise(frozen, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: true })
  const names = new Map<string, { path: string; directory: boolean; explicit: boolean }>()
  let total = 0, files = 0
  const ranges: Array<[number, number]> = []
  try {
    if (zip.entryCount > PACK_LIMITS.files * 2) throw new Error("PACK_LIMIT")
    for await (const entry of zip.eachEntry()) {
      if (++files > PACK_LIMITS.files * 2) throw new Error("PACK_LIMIT")
      const directory = entry.fileName.endsWith("/")
      const path = validatePackPath(directory ? entry.fileName.slice(0, -1) : entry.fileName)
      const mode = entry.externalFileAttributes >>> 16, type = mode & 0o170000
      if (entry.generalPurposeBitFlag & (1 | 64) || ![0, 8].includes(entry.compressionMethod) || type !== 0 && type !== (directory ? 0o040000 : 0o100000) || !directory && mode & 0o111) throw new Error("PACK_SCHEMA")
      // Reject link metadata even when a producer mislabels the POSIX file type.
      if (entry.extraFields.some(f => [0x000d, 0x756e].includes(f.id))) throw new Error("PACK_PATH")
      const local = await zip.readLocalFileHeaderPromise(entry)
      const start = entry.relativeOffsetOfLocalHeader, end = local.fileDataStart + entry.compressedSize
      if (!local.fileName.equals(entry.fileNameRaw) || local.compressionMethod !== entry.compressionMethod || local.generalPurposeBitFlag !== entry.generalPurposeBitFlag || !(entry.generalPurposeBitFlag & 8) && (local.crc32 !== entry.crc32 || local.compressedSize !== entry.compressedSize || local.uncompressedSize !== entry.uncompressedSize) || ranges.some(([a, b]) => start < b && end > a)) throw new Error("PACK_INTEGRITY")
      ranges.push([start, end])
      const parts = path.split("/")
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/"), key = prefix.normalize("NFKC").toLowerCase(), existing = names.get(key)
        const isDir = i < parts.length || directory, explicit = i === parts.length
        if (existing && (existing.path !== prefix || existing.directory !== isDir || existing.explicit && explicit)) throw new Error("PACK_PATH")
        names.set(key, { path: prefix, directory: isDir, explicit: explicit || existing?.explicit === true })
      }
      if (directory) { if (entry.uncompressedSize !== 0 || entry.compressedSize !== 0) throw new Error("PACK_SCHEMA"); continue }
      if (path !== "pack.json" && !isPayloadPath(path)) throw new Error("PACK_SCHEMA")
      if (entry.uncompressedSize > PACK_LIMITS.fileBytes || entry.compressedSize > PACK_LIMITS.archiveBytes) throw new Error("PACK_LIMIT")
      const destination = join(payload, path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      let actual = 0, crc = 0
      await pipeline(await zip.openReadStreamPromise(entry), new Transform({ transform(chunk: Buffer, _encoding, callback) {
        actual += chunk.length; total += chunk.length
        crc = crc32(chunk, crc)
        callback(actual > PACK_LIMITS.fileBytes || total > PACK_LIMITS.payloadBytes ? new Error("PACK_LIMIT") : null, chunk)
      } }), createWriteStream(destination, { flags: "wx", mode: 0o600 }))
      if (actual !== entry.uncompressedSize || crc !== entry.crc32) throw new Error("PACK_INTEGRITY")
    }
  } finally { zip.close() }
  return validatePackDirectory(payload)
}
