import { describe, expect, it } from "vitest"
import { allEventSupport, classifyHandler, handlerIdentity, hookHandler, inspectHookConfiguration, parseLegacyCommand, planHookEdit, type OwnershipContext } from "../adapter/codex/hooks/HookInstallPlan.ts"
import { HOOK_MARKER, legacyHookCommands, type HookLaunchSpec } from "../adapter/codex/hooks/HookLaunchSpec.ts"
import { MAX_HOOK_FILE_BYTES, parseHooksFile, parseUniqueJson, type HooksFile } from "../adapter/codex/hooks/HookJson.ts"

const spec: HookLaunchSpec = { mode: "packaged-electron-node", executablePath: "/Applications/Pet.app/Contents/MacOS/Pet", forwarderPath: "/Applications/Pet.app/Contents/Resources/codex/hook-forwarder.mjs", dataDir: "/Users/test/.pet", hookEndpoint: "http://127.0.0.1:4175/hook" }
const desiredHandler = hookHandler(spec)
const support = allEventSupport("supported")
const context: OwnershipContext = { desiredHandler }
const foreignA = { type: "command", command: "foreign PRIVATE_CANARY_A", statusMessage: "PRIVATE_CANARY_STATUS" }
const foreignB = { type: "command", command: "foreign PRIVATE_CANARY_B", custom: { keep: true } }
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const edit = (before: string | null, action: "install" | "repair" | "uninstall" = "install", overrides: Partial<Parameters<typeof planHookEdit>[0]> = {}) => planHookEdit({ before, action, context, support, ...overrides })

describe("Hook JSON boundary", () => {
  it.each(["", " ", "{", "[]", "null", '{"hooks":[]}', '{"hooks":{"Stop":{}}}', '{"hooks":{"Stop":[{}]}}', '{"hooks":{"Stop":[{"hooks":[null]}]}}']) ("refuses malformed settings instead of replacing %s", (before) => {
    expect(() => parseHooksFile(before)).toThrow("invalid hooks.json")
  })
  it("distinguishes file absence from an empty file and rejects duplicate escaped keys", () => {
    expect(parseHooksFile(null)).toEqual({})
    for (const value of ['{"hooks":{},"hooks":{}}', '{"hooks":{"Stop":[],"St\\u006fp":[]}}', '{"outer":[{"k":1,"k":2}]}']) expect(() => parseUniqueJson(value)).toThrow("DUPLICATE_JSON_KEY")
    expect(parseUniqueJson('{"a":[{"x":"escaped \\" quote"},{"x":1}]}')).toBeDefined()
  })
  it("bounds bytes and nesting", () => {
    expect(() => parseHooksFile(json({ description: "x".repeat(MAX_HOOK_FILE_BYTES) }))).toThrow("FILE_TOO_LARGE")
    expect(() => parseUniqueJson("[".repeat(100) + "0" + "]".repeat(100))).toThrow("JSON_TOO_DEEP")
    expect(() => parseUniqueJson('{"foreignInteger":9007199254740993}')).toThrow("UNSAFE_JSON_NUMBER")
    expect(() => parseUniqueJson('{"foreignNumber":1e999}')).toThrow("UNSAFE_JSON_NUMBER")
  })
})

describe("handler ownership and planning", () => {
  it("preserves mixed group siblings, their order, metadata, and unknown events on uninstall", () => {
    const before = { description: "metadata", future: { version: 7 }, hooks: { Stop: [{ extra: "group metadata", hooks: [foreignA, desiredHandler, foreignB] }], Future: [{ hooks: [foreignB, desiredHandler] }] } }
    const plan = edit(json(before), "uninstall")
    expect(JSON.parse(plan.after!)).toEqual({ ...before, hooks: { Stop: [{ extra: "group metadata", hooks: [foreignA, foreignB] }], Future: [{ hooks: [foreignB] }] } })
    expect(plan.foreignHandlerCount).toBe(3)
    expect(JSON.stringify({ changes: plan.changes, warnings: plan.warnings, conflicts: plan.conflicts })).not.toContain("PRIVATE_CANARY")
    expect(plan.changes.map((item) => item.event)).toContain("Other event")
  })
  it("retains an empty group carrying user metadata", () => {
    const plan = edit(json({ hooks: { Stop: [{ description: "keep", hooks: [desiredHandler] }] } }), "uninstall")
    expect(JSON.parse(plan.after!)).toEqual({ hooks: { Stop: [{ description: "keep", hooks: [] }] } })
  })
  it("does not claim a marker in descriptions or foreign command arguments", () => {
    for (const handler of [{ type: "command", command: `echo ${HOOK_MARKER}` }, { ...foreignA, description: HOOK_MARKER }, { ...foreignB, statusMessage: HOOK_MARKER }]) {
      expect(classifyHandler(handler, { hooks: [handler] }, context)).toBe("foreign")
      const before = json({ description: HOOK_MARKER, hooks: { Stop: [{ hooks: [handler] }] } })
      expect(edit(before, "uninstall")).toMatchObject({ changed: false, after: before })
    }
  })
  it.each([
    { hooks: [{ ...desiredHandler, command: `${desiredHandler.command}; echo unsafe` }] },
    { matcher: "Bash", hooks: [desiredHandler] },
    { hooks: [{ ...desiredHandler, async: true }] },
  ])("blocks ambiguous application entries without executing or deleting them", (group) => {
    const before = json({ hooks: { Stop: [group] } })
    const plan = edit(before, "uninstall")
    expect(plan.conflicts.join()).toContain("AMBIGUOUS_HANDLER")
    expect(plan.after).toBe(before)
    expect(plan.changed).toBe(false)
  })
  it("recognizes exact historical syntax only after its expected handler has been validated", () => {
    const legacy = { type: "command", ...legacyHookCommands("/opt/node", "/사용자/it's a project/adapter/codex/hooks/hook-forwarder.mjs"), timeout: 1 }
    expect(parseLegacyCommand(legacy.command)).toEqual({ executablePath: "/opt/node", forwarderPath: "/사용자/it's a project/adapter/codex/hooks/hook-forwarder.mjs" })
    expect(parseLegacyCommand(`${legacy.command}; echo extra`)).toBeNull()
    expect(parseLegacyCommand(`node '/project/adapter/codex/hooks/hook-forwarder.mjs' # ${HOOK_MARKER}`)).toBeNull()
    expect(classifyHandler(legacy, { hooks: [legacy] }, context)).toBe("ambiguous")
    const known = { ...context, legacyHandlers: [legacy] }
    expect(classifyHandler(legacy, { hooks: [legacy] }, known)).toBe("legacy-recognized")
    const plan = edit(json({ hooks: { Stop: [{ hooks: [foreignA, legacy, foreignB] }] } }), "repair", { context: known })
    const after = JSON.parse(plan.after!)
    expect(after.hooks.Stop[0].hooks).toEqual([foreignA, foreignB])
    expect(after.hooks.Stop[1].hooks).toEqual([desiredHandler])
    expect(plan.changes.some((change) => change.reasonCode === "REPLACE_PREVIOUS_COMMAND")).toBe(true)
  })
  it("distinguishes partial, duplicate, old command, and complete installation; exact reinstall preserves bytes", () => {
    const partial = { hooks: { Stop: [{ hooks: [desiredHandler] }] } }
    expect(inspectHookConfiguration(partial, context, support).status).toBe("partially-installed")
    expect(inspectHookConfiguration({ hooks: { Stop: [{ hooks: [desiredHandler, desiredHandler] }] } }, context, support).status).toBe("repair-needed")
    const complete = edit(null).after!
    const compact = JSON.stringify(JSON.parse(complete))
    expect(edit(compact)).toMatchObject({ changed: false, after: compact, configurationStatus: "installed-current" })
    const old = hookHandler({ ...spec, dataDir: "/Users/test/old-pet" })
    expect(inspectHookConfiguration({ hooks: { Stop: [{ hooks: [old] }] } }, { ...context, receipts: [handlerIdentity(old)] }, support).status).toBe("repair-needed")
  })
  it("adds supported events only, blocks unconfirmed core flow, and never silently drops Interrupt", () => {
    const limited = { ...support, Interrupt: "unsupported" as const }
    expect(JSON.parse(edit(null, "install", { support: limited }).after!).hooks.Interrupt).toBeUndefined()
    const before = json({ hooks: { Interrupt: [{ hooks: [desiredHandler] }] } })
    expect(edit(before, "repair", { support: { ...limited, Interrupt: "unknown" } })).toMatchObject({ after: before, changed: false, conflicts: ["EXISTING_EVENT_UNCONFIRMED"] })
    expect(edit(null, "install", { support: allEventSupport("unknown") }).conflicts).toContain("CORE_EVENTS_UNCONFIRMED")
    expect(edit(before, "uninstall", { support: allEventSupport("unknown") }).changed).toBe(true)
  })
  it("refuses inline or policy conflicts without producing a writable after-image", () => {
    const before = json({ metadata: "PRIVATE_CANARY", hooks: {} })
    expect(edit(before, "install", { blockers: ["INLINE_OWNED_HOOK_CONFLICT"] })).toMatchObject({ changed: false, after: before })
  })
  it("reverts only the owned change while retaining later third-party handlers and metadata", () => {
    const original: HooksFile = { custom: "keep", hooks: { Stop: [{ description: "mixed", hooks: [foreignA, desiredHandler, foreignB] }] } }
    const removed = edit(json(original), "uninstall")
    const later = JSON.parse(removed.after!)
    later.hooks.Stop[0].hooks.push({ type: "command", command: "new third-party C" })
    later.hooks.Future = [{ hooks: [foreignB] }]
    const reverted = planHookEdit({ action: "revert-owned-change", before: json(later), context, support, revert: removed.inverse })
    expect(reverted.conflicts).toEqual([])
    expect(JSON.parse(reverted.after!).hooks).toEqual({ Stop: [{ description: "mixed", hooks: [foreignA, desiredHandler, foreignB, { type: "command", command: "new third-party C" }] }], Future: [{ hooks: [foreignB] }] })
    expect(JSON.stringify(removed.inverse)).not.toContain("PRIVATE_CANARY")
  })
  it("refuses revert if the owned definition or original mixed group has diverged", () => {
    const installed = edit(null)
    const later = JSON.parse(installed.after!)
    later.hooks.Stop[0].hooks.push(desiredHandler)
    expect(planHookEdit({ action: "revert-owned-change", before: json(later), context, support, revert: installed.inverse }).conflicts).toContain("OWNED_CHANGE_DIVERGED")
    const uninstalled = edit(json({ hooks: { Stop: [{ metadata: 1, hooks: [foreignA, desiredHandler] }] } }), "uninstall")
    expect(planHookEdit({ action: "revert-owned-change", before: "{}", context, support, revert: uninstalled.inverse }).conflicts).toContain("REVERT_GROUP_DIVERGED")
  })

  it("bounds mixed-group receipt anchors and handles prototype-named unknown events as data", () => {
    const foreign = Array.from({ length: 1000 }, (_, index) => ({ type: "command", command: `foreign-${index}` }))
    const before = json({ hooks: { Stop: [{ hooks: [...foreign, desiredHandler] }] } })
    const removed = edit(before, "uninstall")
    expect(removed.inverse.beforeOwned[0].foreignSiblingFingerprints).toHaveLength(32)
    expect(JSON.stringify(removed.inverse).length).toBeLessThan(8000)
    const prototypeEvent = `{"hooks":{"__proto__":[{"hooks":[${JSON.stringify(desiredHandler)},${JSON.stringify(foreignA)}]}]}}`
    const uninstall = edit(prototypeEvent, "uninstall")
    const revert = planHookEdit({ action: "revert-owned-change", before: uninstall.after, context, support, revert: uninstall.inverse })
    expect(revert.conflicts).toEqual([])
    expect(JSON.parse(revert.after!).hooks.__proto__[0].hooks).toEqual([desiredHandler, foreignA])
  })
})
