import { Worker } from "node:worker_threads"
import { PACK_LIMITS } from "../shared/character-pack-contract"
import type { ValidatedPack } from "./CharacterPackAssets"

export type PackValidationTask = { kind: "archive" | "directory"; path: string; transactionRoot?: string; rig?: boolean }
export type PackValidator = (task: PackValidationTask, signal?: AbortSignal) => Promise<ValidatedPack>
export function createPackValidator(workerPath: string): PackValidator {
  return (task, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("PACK_CANCELLED")); return }
    const worker = new Worker(workerPath, { workerData: task, resourceLimits: { maxOldGenerationSizeMb: PACK_LIMITS.workerHeapMb, stackSizeMb: 4 }, env: {}, execArgv: [] })
    let done = false
    const finish = (error?: Error, value?: ValidatedPack) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort)
      // Termination completes before staging can be removed or a new worker started.
      void worker.terminate().finally(() => error ? reject(error) : resolve(value!))
    }
    const abort = () => finish(new Error("PACK_CANCELLED"))
    const timer = setTimeout(() => finish(new Error("PACK_TIMEOUT")), PACK_LIMITS.workerTimeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    worker.once("message", result => finish(result.ok ? undefined : new Error(result.code), result.value))
    worker.once("error", () => finish(new Error("PACK_INVALID")))
    worker.once("exit", () => { if (!done) finish(new Error("PACK_INVALID")) })
  })
}
