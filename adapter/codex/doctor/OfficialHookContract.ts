import { readFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import schemas from "./HookWireSchemas.json"
import { allEventSupport } from "../hooks/HookInstallPlan.ts"
import type { HookSupportContract } from "./HookSupportContract.ts"
import { gte, valid } from "semver"
import { MINIMUM_CODEX_VERSION } from "../runtime/OfficialRuntimeVerification.ts"

const invalid = () => Error("HOOK_SCHEMA_UNSUPPORTED")
const checked = new Set<string>()
const keys = new Set(["$schema", "title", "description", "definitions", "$ref", "type", "const", "enum", "required", "properties", "additionalProperties"])

export function extractHookSchema(binary: Buffer, title: string): any {
  const titleAt = binary.indexOf(Buffer.from(`"title": "${title}"`))
  if (titleAt < 0) throw invalid()
  const start = Math.max(...['{\n  "$schema"', '{\r\n  "$schema"'].map(prefix => binary.lastIndexOf(Buffer.from(prefix), titleAt)))
  if (start < 0 || titleAt - start >= 65536) throw invalid()
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < Math.min(binary.length, start + 65536); i++) {
    const ch = binary[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === 92) escaped = true
      else if (ch === 34) quoted = false
    } else if (ch === 34) quoted = true
    else if (ch === 123) depth++
    else if (ch === 125 && --depth === 0) {
      const schema = JSON.parse(binary.subarray(start, i + 1).toString("utf8"))
      if (schema.title !== title) throw invalid()
      return schema
    }
  }
  throw invalid()
}

function resolved(schema: any, root: any, depth = 0): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 8 || Object.keys(schema).some(key => !keys.has(key))) throw invalid()
  if (!schema.$ref) return schema
  if (!/^#\/definitions\/[A-Za-z0-9_]+$/.test(schema.$ref)) throw invalid()
  return resolved(root.definitions?.[schema.$ref.split("/").at(-1)], root, depth + 1)
}

/** Permit additive fields, not changed types/required wire data. This validates
 * the installed binary's contract; it is not proof of actual event delivery. */
export function assertCompatibleHookInput(actual: any, expected: any) {
  const root = resolved(actual, actual)
  if (root.type !== "object" || !Array.isArray(root.required) || !root.properties) throw invalid()
  for (const key of expected.required) if (!root.required.includes(key)) throw invalid()
  for (const [name, value] of Object.entries(expected.properties)) {
    if (value === true) { if (!Object.hasOwn(root.properties, name)) throw invalid(); continue }
    const a = resolved(root.properties[name], actual), e = resolved(value, expected)
    if (JSON.stringify([a.type].flat().sort()) !== JSON.stringify([e.type].flat().sort())) throw invalid()
    if (Object.hasOwn(e, "const") && a.const !== e.const) throw invalid()
    if (e.enum && (!Array.isArray(a.enum) || !a.enum.length || a.enum.some((item: unknown) => !e.enum.includes(item)))) throw invalid()
  }
}

export async function officialHookContract(executable: string, runtime: { version: string; executableSha256: string }, signal: AbortSignal): Promise<HookSupportContract> {
  signal.throwIfAborted()
  if (!valid(runtime.version) || !gte(runtime.version, MINIMUM_CODEX_VERSION)) throw invalid()
  if (!checked.has(runtime.executableSha256)) {
    if ((await stat(executable)).size > 350 * 1024 * 1024) throw invalid()
    const binary = await readFile(executable, { signal })
    if (createHash("sha256").update(binary).digest("hex") !== runtime.executableSha256) throw invalid()
    for (const [event, expected] of Object.entries(schemas)) {
      assertCompatibleHookInput(extractHookSchema(binary, expected.title), expected)
      if (event !== "SessionEnd") {
        const output = extractHookSchema(binary, expected.title.replace(/\.input$/, ".output"))
        resolved(output, output)
        if (output.type !== "object" || output.const !== undefined || output.enum !== undefined || output.required !== undefined && (!Array.isArray(output.required) || output.required.length !== 0)) throw invalid()
      }
    }
    signal.throwIfAborted()
    if (checked.size >= 16) checked.delete(checked.values().next().value!)
    checked.add(runtime.executableSha256)
  }
  return { id: `official-cli-${runtime.version}-${runtime.executableSha256.slice(0, 16)}`, version: `codex-cli ${runtime.version}`,
    artifactSha256: runtime.executableSha256, surface: "cli", source: "official-artifact-and-embedded-schemas",
    events: allEventSupport("supported"), featureKey: "hooks", eventTimeoutSeconds: process.platform === "win32" ? 3 : 2 }
}
