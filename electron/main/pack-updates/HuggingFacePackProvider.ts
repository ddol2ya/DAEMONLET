import { request } from "node:https"
import { lookup } from "node:dns"
import { BlockList } from "node:net"
import { createHash } from "node:crypto"
import { open, rename, rm } from "node:fs/promises"
import { PACK_UPDATE_LIMITS, hfPath, parseUpdateFeed, parseUpdateSource, type PackUpdateSource, type PackUpdateFeed } from "../../shared/pack-update-contract"

// HF resolve may redirect to its LFS/Xet delivery hosts. Never accept a suffix wildcard.
export const HF_DOWNLOAD_HOSTS = new Set(["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co", "us.gcp.cdn.hf.co", "cas-server.xethub.hf.co", "cas-server.xethub-eu.hf.co", "transfer.xethub.hf.co", "transfer.xethub-eu.hf.co"])
export function validateHfUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw Error("PACK_UPDATE_REDIRECT") }
  if (value.length > 16_384 || url.protocol !== "https:" || !HF_DOWNLOAD_HOSTS.has(url.hostname) || url.port && url.port !== "443" || url.username || url.password || url.hash) throw Error("PACK_UPDATE_REDIRECT")
  return url
}
export function hfResolve(source: PackUpdateSource, path = source.manifestPath, revision = "main"): string {
  parseUpdateSource(source); hfPath(path, revision === "main" ? ".json" : ".petchar")
  if (revision !== "main" && !/^[a-f0-9]{40}$/.test(revision)) throw Error("PACK_UPDATE_METADATA")
  return `https://huggingface.co/datasets/${source.repoId}/resolve/${revision}/${path}`
}
const privateAddresses = new BlockList()
for (const [address, prefix] of [["0.0.0.0", 8], [[10, 0, 0, 0].join("."), 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], [[172, 16, 0, 0].join("."), 12], [[192, 168, 0, 0].join("."), 16], ["192.0.0.0", 24], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) privateAddresses.addSubnet(address, prefix)
const privateV6 = new BlockList()
for (const [address, prefix] of [["::", 96], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) privateV6.addSubnet(address, prefix, "ipv6")
export const publicHfAddress = (address: string, family: number) => !(family === 6 ? privateV6 : privateAddresses).check(address, family === 6 ? "ipv6" : "ipv4")
export type HfResponse = { status: number; headers: Record<string, string | undefined>; body: AsyncIterable<Uint8Array>; close(): void }
export type HfOpen = (url: URL, signal: AbortSignal, headers: Record<string, string>) => Promise<HfResponse>
const openAnonymous: HfOpen = (url, signal, headers) => new Promise((resolve, reject) => {
  // node:https uses neither Chromium cookies, proxy sessions nor local HF credentials.
  const req = request(url, { method: "GET", signal, headers: { Accept: "application/octet-stream", "Accept-Encoding": "identity", ...headers }, lookup: (host, options, callback) => {
    lookup(host, { all: true }, (error, addresses) => {
      if (error || !addresses.length || addresses.some(a => !publicHfAddress(a.address, a.family))) { callback(error ?? Error("PACK_UPDATE_REDIRECT"), "", 4); return }
      if (options.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    })
  } }, response => resolve({ status: response.statusCode ?? 0, headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), body: response, close: () => response.destroy() }))
  req.setTimeout(PACK_UPDATE_LIMITS.idleTimeoutMs, () => req.destroy(Error("PACK_UPDATE_TIMEOUT")))
  req.once("error", error => reject(Error(error.message === "PACK_UPDATE_REDIRECT" || error.message === "PACK_UPDATE_TIMEOUT" ? error.message : signal.aborted ? "PACK_CANCELLED" : "PACK_UPDATE_NETWORK")))
  req.end()
})
export class HfRateError extends Error { constructor(readonly retryMs: number) { super("PACK_UPDATE_RATE") } }
export class HuggingFacePackProvider {
  constructor(private readonly openResponse: HfOpen = openAnonymous) {}
  private async response(source: PackUpdateSource, path: string, revision: string, signal: AbortSignal, etag?: string) {
    let url = hfResolve(source, path, revision)
    for (let hop = 0; hop <= PACK_UPDATE_LIMITS.redirects; hop++) {
      signal.throwIfAborted()
      const target = validateHfUrl(url)
      const response = await this.openResponse(target, signal, etag && target.hostname === "huggingface.co" ? { "If-None-Match": etag } : {})
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.close()
        if (!response.headers.location || hop === PACK_UPDATE_LIMITS.redirects) throw Error("PACK_UPDATE_REDIRECT")
        url = new URL(response.headers.location, target).href; continue
      }
      if (response.status === 429) {
        response.close()
        const raw = response.headers["retry-after"], reset = response.headers.ratelimit?.match(/\bt=(\d+)/)?.[1]
        const delay = raw ? /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now() : Number(reset ?? 300) * 1000
        throw new HfRateError(Math.min(24 * 60 * 60_000, Math.max(60_000, Number.isFinite(delay) ? delay : 300_000)))
      }
      if (![200, 304].includes(response.status)) { response.close(); throw Error(response.status === 403 ? "PACK_UPDATE_HTTP_403" : response.status === 404 ? "PACK_UPDATE_HTTP_404" : "PACK_UPDATE_NETWORK") }
      return response
    }
    throw Error("PACK_UPDATE_REDIRECT")
  }
  async feed(source: PackUpdateSource, signal: AbortSignal, etag?: string): Promise<{ feed?: PackUpdateFeed; etag?: string; notModified: boolean }> {
    const timeout = AbortSignal.timeout(PACK_UPDATE_LIMITS.metadataTimeoutMs), combined = AbortSignal.any([signal, timeout])
    let response: HfResponse | undefined
    try {
      response = await this.response(source, source.manifestPath, "main", combined, etag)
      if (response.status === 304) return { notModified: true }
      if (/text\/html/i.test(response.headers["content-type"] ?? "")) throw Error("PACK_UPDATE_METADATA")
      const chunks: Uint8Array[] = []; let size = 0
      for await (const chunk of response.body) { combined.throwIfAborted(); size += chunk.length; if (size > PACK_UPDATE_LIMITS.feedBytes) throw Error("PACK_UPDATE_METADATA"); chunks.push(chunk) }
      combined.throwIfAborted()
      const tag = response.headers.etag
      return { feed: parseUpdateFeed(Buffer.concat(chunks)), notModified: false, ...(tag && tag.length <= 256 && !/[\u0000-\u001f\u007f]/.test(tag) ? { etag: tag } : {}) }
    } catch (error) { if (signal.aborted) throw Error("PACK_CANCELLED"); if (timeout.aborted) throw Error("PACK_UPDATE_TIMEOUT"); throw error }
    finally { response?.close() }
  }
  async download(source: PackUpdateSource, feed: PackUpdateFeed, path: string, signal: AbortSignal, progress: (received: number) => void): Promise<void> {
    const timeout = AbortSignal.timeout(PACK_UPDATE_LIMITS.downloadTimeoutMs), combined = AbortSignal.any([signal, timeout]), partial = path + ".partial"
    let response: HfResponse | undefined, file: Awaited<ReturnType<typeof open>> | undefined
    try {
      response = await this.response(source, feed.artifact.path, feed.artifact.revision, combined)
      if (response.status !== 200 || /(?:text\/html|text\/plain)/i.test(response.headers["content-type"] ?? "")) throw Error("PACK_INTEGRITY")
      const length = response.headers["content-length"]
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== feed.artifact.bytes)) throw Error("PACK_INTEGRITY")
      file = await open(partial, "wx", 0o600)
      const hash = createHash("sha256"); let received = 0, signature = Buffer.alloc(0)
      for await (const chunk of response.body) {
        combined.throwIfAborted(); received += chunk.length
        if (received > feed.artifact.bytes) throw Error("PACK_INTEGRITY")
        if (signature.length < 4) signature = Buffer.concat([signature, Buffer.from(chunk)]).subarray(0, 4)
        hash.update(chunk); await file.writeFile(chunk); progress(received)
      }
      combined.throwIfAborted()
      if (signature.toString("hex") !== "504b0304" || received !== feed.artifact.bytes || hash.digest("hex") !== feed.artifact.sha256) throw Error("PACK_INTEGRITY")
      await file.sync(); await file.close(); file = undefined
      combined.throwIfAborted(); await rename(partial, path)
    } catch (error) { if (signal.aborted) throw Error("PACK_CANCELLED"); if (timeout.aborted) throw Error("PACK_UPDATE_TIMEOUT"); throw error }
    finally { response?.close(); await file?.close(); await rm(partial, { force: true }) }
  }
}
