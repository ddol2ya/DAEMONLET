import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { createGunzip } from "node:zlib"

const LIMIT = 512 * 1024 * 1024
const invalid = () => Error("CHAT_RUNTIME_UNSUPPORTED")
const text = (value: Buffer) => value.toString("utf8").replace(/\0.*$/s, "")

/** Hash the exact regular-file payload in an npm tarball without extracting or
 * executing any entry. Both the complete compressed integrity and native digest
 * are required; symlinks, duplicate targets and truncated archives fail closed. */
export async function hashOfficialRuntimeArchive(bytes: AsyncIterable<Uint8Array>, target: string, integrity: string, signal: AbortSignal) {
  const archiveHash = createHash("sha512"), nativeHash = createHash("sha256")
  let compressed = 0, expanded = 0, entries = 0, zeros = 0, found = false, nativeBytes = 0
  let remaining = 0, padding = 0, selected = false, headerBytes = 0
  const header = Buffer.alloc(512)
  const source = Readable.from((async function* () {
    for await (const chunk of bytes) {
      signal.throwIfAborted()
      compressed += chunk.length
      if (compressed > LIMIT) throw invalid()
      archiveHash.update(chunk); yield chunk
    }
  })())
  const gunzip = createGunzip()
  const abort = () => { source.destroy(invalid()); gunzip.destroy(invalid()) }
  source.on("error", error => gunzip.destroy(error))
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    for await (const data of source.pipe(gunzip)) {
      const chunk = data as Buffer
      expanded += chunk.length
      if (expanded > 2 * LIMIT) throw invalid()
      let offset = 0
      while (offset < chunk.length) {
        if (remaining) {
          const take = Math.min(remaining, chunk.length - offset)
          if (selected) nativeHash.update(chunk.subarray(offset, offset + take))
          remaining -= take; offset += take
        } else if (padding) {
          const take = Math.min(padding, chunk.length - offset)
          padding -= take; offset += take
        } else {
          const take = Math.min(512 - headerBytes, chunk.length - offset)
          chunk.copy(header, headerBytes, offset, offset + take); headerBytes += take; offset += take
          if (headerBytes !== 512) continue
          headerBytes = 0
          if (header.every(byte => byte === 0)) { zeros++; continue }
          if (zeros || ++entries > 4096) throw invalid()
          const checksum = text(header.subarray(148, 156)).trim()
          const size = text(header.subarray(124, 136)).trim()
          if (!/^[0-7]+$/.test(checksum) || !/^[0-7]+$/.test(size)) throw invalid()
          const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0)
          if (parseInt(checksum, 8) !== sum) throw invalid()
          remaining = parseInt(size, 8)
          if (!Number.isSafeInteger(remaining) || remaining > LIMIT) throw invalid()
          padding = (512 - remaining % 512) % 512
          const prefix = text(header.subarray(345, 500)), name = text(header.subarray(0, 100))
          const path = prefix ? `${prefix}/${name}` : name
          selected = path === target
          // Extended name headers change interpretation of later entries. Do not
          // accept them until this bounded reader explicitly supports them.
          if (![0, 48, 49, 50, 53].includes(header[156])) throw invalid()
          if (selected) {
            if (found || ![0, 48].includes(header[156]) || !remaining) throw invalid()
            found = true; nativeBytes = remaining
          }
        }
      }
    }
    signal.throwIfAborted()
    if (!found || remaining || padding || headerBytes || zeros < 2 || `sha512-${archiveHash.digest("base64")}` !== integrity) throw invalid()
    return { executableSha256: nativeHash.digest("hex"), executableBytes: nativeBytes }
  } finally {
    signal.removeEventListener("abort", abort); source.destroy(); gunzip.destroy()
  }
}
