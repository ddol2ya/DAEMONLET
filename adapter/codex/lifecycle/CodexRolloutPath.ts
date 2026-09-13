import { basename } from "node:path"

const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
const rollout = new RegExp(`^rollout-.+-(${uuid})(?:_${uuid})?\\.jsonl$`, "i")

/** Continued desktop sessions append a file ID after the original conversation ID. */
export function rolloutSessionId(path: string): string | null {
  return rollout.exec(basename(path))?.[1] ?? null
}
