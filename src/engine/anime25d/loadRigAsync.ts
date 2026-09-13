import type { PsdRigLoader } from "./PsdRigLoader"
import type { RigOverrides } from "./RigOverrides"
import type { RigLoadResult } from "./types"

// One decode at a time bounds CPU and peak memory. Discard superseded requests
// before allocating a worker; cancellation terminates an in-flight decode.
let tail = Promise.resolve()
const retainedBytes = new WeakMap<RigLoadResult, number>()
export function rigDecodeCacheBytes(result: RigLoadResult): number {
  return retainedBytes.get(result) ?? result.model.rig.layers.reduce((sum, layer) => sum + layer.img.data.byteLength * 3, 0)
}
function account(result: RigLoadResult, sourceBytes: number): RigLoadResult {
  retainedBytes.set(result, sourceBytes + result.model.rig.layers.reduce((sum, layer) => sum + layer.img.data.byteLength * 3, 0))
  return result
}
export async function loadRigAsync(loader: PsdRigLoader, buffer: ArrayBuffer, name: string, overrides: RigOverrides, signal?: AbortSignal): Promise<RigLoadResult> {
  signal?.throwIfAborted()
  if (typeof Worker === "undefined") return account(loader.loadArrayBuffer(buffer, name, overrides), buffer.byteLength)
  const previous = tail
  let release!: () => void
  tail = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    signal?.throwIfAborted()
    const result = await new Promise<RigLoadResult>((resolve, reject) => {
      const worker = new Worker(new URL("./RigDecodeWorker.ts", import.meta.url), { type: "module" })
      const finish = (value?: RigLoadResult, error?: unknown) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.terminate()
        if (value) resolve(value); else reject(error)
      }
      const abort = () => finish(undefined, new DOMException("Rig decode cancelled", "AbortError"))
      const timer = setTimeout(() => finish(undefined, new Error("Rig decode timed out")), 30_000)
      signal?.addEventListener("abort", abort, { once: true })
      worker.onerror = () => finish(undefined, new Error("Rig decoder failed"))
      worker.onmessage = event => event.data.error ? finish(undefined, new Error(event.data.error)) : finish(event.data.result)
      worker.postMessage({ buffer, name, overrides })
    })
    // Authoring views can still inspect the full PSD. Normal animation keeps
    // only the compressed source plus the decoded rig and small diagnostics.
    let inspected: RigLoadResult | undefined
    for (const key of ["rawComposite", "cleanedComposite", "rawCompositeLayers", "cleanedCompositeLayers"] as const) {
      Object.defineProperty(result.model, key, { enumerable: true, get: () => (inspected ??= loader.loadArrayBuffer(buffer, name, overrides)).model[key] })
    }
    return account(result, buffer.byteLength)
  } finally { release() }
}
