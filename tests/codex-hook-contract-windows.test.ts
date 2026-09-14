import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { hookContractFor } from "../adapter/codex/doctor/HookSupportContract.ts"
import { validateHookEvent } from "../adapter/codex/hooks/HookEventValidator.ts"
import { sanitizeHookPayload } from "../adapter/codex/hooks/hook-forwarder.mjs"
import { validateSanitizedHookIngress } from "../adapter/codex/hooks/SanitizedHookIngress.ts"
import { assertWireFixture } from "../scripts/verify-codex-hook-contract.mjs"

const fixtures = JSON.parse(readFileSync("tests/fixtures/codex-hooks/contract-v0.151.0-win32.json", "utf8")) as {
  codexVersion: string; artifactSha256: string
  events: { event: string; schema: Record<string, unknown>; input: Record<string, unknown> }[]
}

describe("Codex 0.151.0 Windows Hook wire compatibility", () => {
  it("binds the reviewed schema fixtures to one exact native artifact and version", () => {
    const contract = hookContractFor(fixtures.artifactSha256, fixtures.codexVersion)
    expect(contract?.id).toBe("codex-cli-0.151.0-win32-x64")
    expect(Object.keys(contract!.events).sort()).toEqual(fixtures.events.map(item => item.event).sort())
    expect(hookContractFor(fixtures.artifactSha256, "codex-cli 0.153.5")).toBeNull()
    expect(hookContractFor("unreviewed-artifact", fixtures.codexVersion)).toBeNull()
  })
  it.each(fixtures.events)("accepts the embedded $event contract and strips content before ingress", ({ event, schema, input }) => {
    expect(() => assertWireFixture(schema, input)).not.toThrow()
    const raw = validateHookEvent(input, 100)
    expect(raw.ok).toBe(true)
    if (raw.ok) expect(raw.value.hookEventName).toBe(event)
    const sanitized = sanitizeHookPayload(input)
    const ingress = validateSanitizedHookIngress(sanitized, 100)
    expect(ingress.ok).toBe(true)
    if (ingress.ok) expect(ingress.value.hookEventName).toBe(event)
    expect(JSON.stringify([raw, sanitized, ingress])).not.toMatch(/fixture content to discard|transcript_path|last_assistant_message|tool_input|tool_response/)
    expect(JSON.stringify([sanitized, ingress])).not.toContain("/fixture/0.153.4")
  })
})
