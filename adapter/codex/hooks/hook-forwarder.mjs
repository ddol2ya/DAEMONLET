#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const MAX_BYTES = 64 * 1024
const DEFAULT_ENDPOINT = "http://127.0.0.1:4175/hook"

export function parseLoopbackHookUrl(value) {
  const literal = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(\[[^\]]+\]|[^:/?#@]+)(?::([0-9]+))?(\/[^?#]*)?$/.exec(value)
  if (!literal || literal[1].toLowerCase() !== "http") return null
  const literalHost = literal[2].toLowerCase()
  if (!["127.0.0.1", "localhost", "[::1]"].includes(literalHost)) return null
  if (literal[3]) {
    const literalPort = Number(literal[3])
    if (!Number.isSafeInteger(literalPort) || literalPort < 1 || literalPort > 65_535) return null
  }
  if (literal[4] !== "/hook") return null
  let url
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== "http:") return null
  if (url.hostname.toLowerCase() !== literalHost) return null
  if (url.username || url.password) return null
  if (url.pathname !== "/hook" || url.search || url.hash) return null
  return url
}

export function hookTimeout(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 250
  return Math.min(1_000, Math.max(50, Math.trunc(parsed)))
}

const text = (value, max = 512) => typeof value === "string" && value.length > 0 && value.length <= max
const permissionModes = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]

export function sanitizeHookPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !text(value.session_id) || !text(value.cwd, 4096) || !text(value.hook_event_name, 64)) return {}
  const name = value.hook_event_name
  const base = { payloadVersion: 1, hookEventName: name, sessionId: value.session_id }
  if (name === "SessionEnd") return text(value.reason, 256) ? { ...base, reason: value.reason } : {}
  if (!text(value.model, 256)) return {}
  if (value.permission_mode !== undefined && (!text(value.permission_mode, 64) || !permissionModes.includes(value.permission_mode))) return {}
  const context = { ...base, model: value.model, ...(text(value.permission_mode, 64) ? { permissionMode: value.permission_mode } : {}) }
  if (name === "SessionStart") return ["startup", "resume", "clear", "compact"].includes(value.source) ? { ...context, source: value.source } : {}
  if (!text(value.turn_id)) return {}
  if (name === "UserPromptSubmit") return text(value.prompt, MAX_BYTES) ? { ...context, turnId: value.turn_id } : {}
  if (name === "PreToolUse" || name === "PostToolUse") {
    if (!text(value.tool_name, 256) || !text(value.tool_use_id) || !("tool_input" in value) || (name === "PostToolUse" && !("tool_response" in value))) return {}
    return { ...context, turnId: value.turn_id, toolName: value.tool_name, toolUseId: value.tool_use_id }
  }
  if (name === "SubagentStart" || name === "SubagentStop") {
    if (!text(value.agent_id) || !text(value.agent_type, 256)) return {}
    return { ...context, turnId: value.turn_id, agentId: value.agent_id, agentType: value.agent_type }
  }
  if (name === "Interrupt" && text(value.permission_mode, 64)) {
    return { ...context, turnId: value.turn_id, permissionMode: value.permission_mode }
  }
  if (name === "Stop" && text(value.permission_mode, 64) && typeof value.stop_hook_active === "boolean" && (value.last_assistant_message === null || typeof value.last_assistant_message === "string")) {
    return { ...context, turnId: value.turn_id, permissionMode: value.permission_mode, stopHookActive: value.stop_hook_active }
  }
  return {}
}

async function readStdin() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_BYTES) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function forward() {
  try {
    const body = await readStdin()
    if (body) {
      const parsed = JSON.parse(body.toString("utf8"))
      const sanitized = sanitizeHookPayload(parsed)
      if (!sanitized.hookEventName) throw new Error("invalid hook input")
      const endpoint = parseLoopbackHookUrl(process.env.CODEX_PET_HOOK_URL || DEFAULT_ENDPOINT)
      if (!endpoint) return
      const dataDir = process.env.CODEX_PET_DATA_DIR || join(homedir(), ".codex-pet")
      const token = (await readFile(join(dataDir, "adapter-token"), "utf8")).trim()
      if (token) {
        await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(sanitized),
          redirect: "error",
          signal: AbortSignal.timeout(hookTimeout(process.env.CODEX_PET_HOOK_TIMEOUT_MS)),
        }).catch(() => undefined)
      }
    }
  } catch {}
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (import.meta.url === invokedPath) {
  // Bound stdin, token-file I/O and HTTP together, including a never-ended stdin
  // or stalled receiver. The parent host probe separately measures cold start.
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    process.stdout.on("error", () => process.exit(0))
    process.stdout.write("{}\n", () => process.exit(0))
  }
  const watchdog = setTimeout(finish, 650)
  await forward()
  clearTimeout(watchdog)
  finish()
}
