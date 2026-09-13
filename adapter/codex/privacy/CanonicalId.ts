import { createHash } from "node:crypto"

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256")
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8")
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.length)
    hash.update(length)
    hash.update(bytes)
  }
  return hash.digest("base64url").slice(0, 32)
}

export const canonicalRunId = (sessionId: string, turnId: string) => `codex-run-${digest([sessionId, turnId])}`
export const canonicalTaskId = (sessionId: string, turnId: string, taskId: string) => `codex-task-${digest([sessionId, turnId, taskId])}`
export const diagnosticId = (value: string) => digest([value]).slice(0, 12)
export const activityCorrelationKey = (runId: string) => createHash("sha256").update("codex-adapter\0").update(runId).digest("hex")
