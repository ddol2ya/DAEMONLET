import { posix } from "node:path"
import { createHookCommand, hashText, HOOK_MARKER, legacyHookCommands, PACKAGED_HOOK_TIMEOUT_SECONDS, type HookLaunchSpec } from "./HookLaunchSpec.ts"
import { MAX_HOOK_FILE_BYTES, isObject, parseHooksFile, type HookGroup, type HooksFile, type JsonObject } from "./HookJson.ts"
import { HOOK_EVENTS } from "./HookEvents.ts"

export const INSTALLED_HOOK_EVENTS = HOOK_EVENTS
export type HookEventName = typeof INSTALLED_HOOK_EVENTS[number]
export type SupportStatus = "supported" | "unsupported" | "unknown"
export type EventSupport = Record<HookEventName, SupportStatus>
export type HookPlanAction = "install" | "repair" | "uninstall" | "revert-owned-change"
export type Ownership = "managed-exact" | "legacy-recognized" | "ambiguous" | "foreign"
export type ConfigurationStatus = "not-installed" | "installed-current" | "installed-legacy" | "partially-installed" | "repair-needed" | "configuration-conflict"
export type HandlerIdentity = { handlerFingerprint: string; commandFingerprint: string }
export type OwnershipContext = {
  desiredHandler: JsonObject
  receipts?: HandlerIdentity[]
  legacyHandlers?: JsonObject[]
}
export type OwnedPlacement = {
  event: string
  groupIndex: number
  handlerIndex: number
  handler: JsonObject
  groupMetadataFingerprint: string
  foreignSiblingFingerprints: string[]
  pureGroup: boolean
}
export type OwnedChange = { beforeOwned: OwnedPlacement[]; afterOwned: OwnedPlacement[] }
export type HookChangeSummary = { event: string; operation: "add" | "remove" | "restore"; reasonCode: string; groupIndex?: number; handlerIndex?: number }
export type HookEditPlan = {
  action: HookPlanAction
  before: string | null
  after: string | null
  changed: boolean
  configurationStatus: ConfigurationStatus
  changes: HookChangeSummary[]
  warnings: string[]
  conflicts: string[]
  foreignHandlerCount: number
  managedHandlerCount: number
  inverse: OwnedChange
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}
export const fingerprintHandler = (handler: JsonObject): string => hashText(stableJson(handler))
export const handlerIdentity = (handler: JsonObject): HandlerIdentity => ({ handlerFingerprint: fingerprintHandler(handler), commandFingerprint: hashText(String(handler.command ?? "")) })
export const allEventSupport = (support: SupportStatus): EventSupport => Object.fromEntries(INSTALLED_HOOK_EVENTS.map((event) => [event, support])) as EventSupport
const publicEvent = (event: string): string => (INSTALLED_HOOK_EVENTS as readonly string[]).includes(event) ? event : "Other event"

export function hookHandler(spec: HookLaunchSpec, legacyDevelopment = false): JsonObject {
  if (legacyDevelopment) return { type: "command", ...legacyHookCommands(spec.executablePath, spec.forwarderPath), timeout: 1 }
  return { type: "command", command: createHookCommand(spec), timeout: spec.mode !== "development-node" ? PACKAGED_HOOK_TIMEOUT_SECONDS : 1 }
}

export function classifyHandler(handler: JsonObject, group: HookGroup, context: OwnershipContext): Ownership {
  const identity = handlerIdentity(handler)
  const exact = identity.handlerFingerprint === fingerprintHandler(context.desiredHandler)
  const recorded = context.receipts?.some((item) => item.handlerFingerprint === identity.handlerFingerprint && item.commandFingerprint === identity.commandFingerprint)
  const legacy = context.legacyHandlers?.some((item) => fingerprintHandler(item) === identity.handlerFingerprint)
  if (exact || recorded || legacy) {
    if (Object.hasOwn(group, "matcher")) return "ambiguous"
    return legacy && !exact && !recorded ? "legacy-recognized" : "managed-exact"
  }
  const command = typeof handler.command === "string" ? handler.command : ""
  const resemblesOwnedCommand = command.includes(HOOK_MARKER) && (command.includes("hook-forwarder.mjs") || command.includes("hook-host.exe") || command.startsWith("/usr/bin/env -i "))
  return resemblesOwnedCommand ? "ambiguous" : "foreign"
}

// Recognize only the exact historical two-literal command syntax. No shell,
// expansion, tokenization library with evaluation, or command execution.
export function parseLegacyCommand(command: string): { executablePath: string; forwarderPath: string } | null {
  let index = 0
  const literal = (): string | null => {
    if (command[index++] !== "'") return null
    let result = ""
    while (index < command.length) {
      if (command.slice(index, index + 5) === `'"'"'`) { result += "'"; index += 5; continue }
      if (command[index] === "'") { index++; return result }
      result += command[index++]
    }
    return null
  }
  const executablePath = literal()
  if (command[index++] !== " ") return null
  const forwarderPath = literal()
  if (executablePath === null || forwarderPath === null || !posix.isAbsolute(executablePath) || !posix.isAbsolute(forwarderPath)
    || /[\0\r\n]/.test(executablePath + forwarderPath) || !forwarderPath.endsWith("/adapter/codex/hooks/hook-forwarder.mjs")) return null
  if (command.slice(index) !== ` # ${HOOK_MARKER}` || legacyHookCommands(executablePath, forwarderPath).command !== command) return null
  return { executablePath, forwarderPath }
}

function groupMetadataFingerprint(group: HookGroup): string {
  const { hooks: _hooks, ...metadata } = group
  return hashText(stableJson(metadata))
}

function ownedPlacements(file: HooksFile, context: OwnershipContext): OwnedPlacement[] {
  const result: OwnedPlacement[] = []
  for (const [event, groups] of Object.entries(file.hooks ?? {})) groups.forEach((group, groupIndex) => {
    const foreign = group.hooks.filter((handler) => classifyHandler(handler, group, context) === "foreign")
    // Bounded anchors identify a surviving mixed group without copying every
    // sibling fingerprint into every owned placement (quadratic receipt size).
    const foreignSiblingFingerprints = [...foreign.slice(0, 16), ...foreign.slice(Math.max(16, foreign.length - 16))].map(fingerprintHandler)
    group.hooks.forEach((handler, handlerIndex) => {
      const ownership = classifyHandler(handler, group, context)
      if (ownership !== "managed-exact" && ownership !== "legacy-recognized") return
      if (result.length < 512) result.push({ event, groupIndex, handlerIndex, handler: structuredClone(handler), groupMetadataFingerprint: groupMetadataFingerprint(group), foreignSiblingFingerprints, pureGroup: Object.keys(group).length === 1 && foreign.length === 0 })
    })
  })
  return result
}

export function inspectHookConfiguration(file: HooksFile, context: OwnershipContext, support: EventSupport): { status: ConfigurationStatus; foreign: number; managed: number; conflicts: string[] } {
  let foreign = 0, managed = 0, legacy = 0, stale = 0
  const counts = new Map<string, number>()
  const conflicts: string[] = []
  for (const [event, groups] of Object.entries(file.hooks ?? {})) groups.forEach((group, groupIndex) => group.hooks.forEach((handler, handlerIndex) => {
    const ownership = classifyHandler(handler, group, context)
    if (ownership === "foreign") foreign++
    else if (ownership === "ambiguous") conflicts.push(`AMBIGUOUS_HANDLER:${publicEvent(event)}:${groupIndex}:${handlerIndex}`)
    else {
      managed++
      counts.set(event, (counts.get(event) ?? 0) + 1)
      if (ownership === "legacy-recognized") legacy++
      if (fingerprintHandler(handler) !== fingerprintHandler(context.desiredHandler)) stale++
    }
  }))
  const selected = INSTALLED_HOOK_EVENTS.filter((event) => support[event] === "supported")
  const missing = selected.some((event) => !counts.get(event))
  const duplicates = [...counts.values()].some((count) => count > 1)
  const status: ConfigurationStatus = conflicts.length ? "configuration-conflict"
    : managed === 0 ? "not-installed"
    : legacy === managed ? "installed-legacy"
    : duplicates || stale ? "repair-needed"
    : missing || selected.length === 0 ? "partially-installed" : "installed-current"
  return { status, foreign, managed, conflicts }
}

function removeOwned(file: HooksFile, context: OwnershipContext, shouldRemove: (event: string) => boolean, changes: HookChangeSummary[], reasonCode: string): void {
  if (!file.hooks) return
  for (const [event, groups] of Object.entries(file.hooks)) {
    if (!shouldRemove(event)) continue
    const nextGroups: HookGroup[] = []
    groups.forEach((group, groupIndex) => {
      const remaining = group.hooks.filter((handler, handlerIndex) => {
        const owned = ["managed-exact", "legacy-recognized"].includes(classifyHandler(handler, group, context))
        if (owned) changes.push({ event: publicEvent(event), operation: "remove", reasonCode, groupIndex, handlerIndex })
        return !owned
      })
      if (remaining.length || Object.keys(group).length > 1 || remaining.length === group.hooks.length) nextGroups.push({ ...group, hooks: remaining })
    })
    if (nextGroups.length) file.hooks[event] = nextGroups
    else if (groups.length) delete file.hooks[event]
  }
}

function ownedSignature(placements: OwnedPlacement[]): string {
  return stableJson(placements.map((item) => ({ event: item.event, handler: fingerprintHandler(item.handler) })).sort((a, b) => stableJson(a).localeCompare(stableJson(b))))
}

function containsInOrder(values: string[], expected: string[]): boolean {
  let next = 0
  for (const value of values) if (value === expected[next]) next++
  return next === expected.length
}

export function planHookEdit(options: {
  action: HookPlanAction
  before: string | null
  context: OwnershipContext
  support: EventSupport
  revert?: OwnedChange
  blockers?: string[]
}): HookEditPlan {
  const file = parseHooksFile(options.before)
  const next = structuredClone(file)
  const inspection = inspectHookConfiguration(file, options.context, options.support)
  const changes: HookChangeSummary[] = []
  const warnings: string[] = []
  const conflicts = [...inspection.conflicts, ...(options.blockers ?? [])]
  const beforeOwned = ownedPlacements(file, options.context)
  if (options.action === "install" || options.action === "repair") {
    if (options.support.UserPromptSubmit !== "supported" || options.support.Stop !== "supported") conflicts.push("CORE_EVENTS_UNCONFIRMED")
    const unconfirmed = beforeOwned.filter((item) => options.support[item.event as HookEventName] !== "supported")
    if (unconfirmed.length) { warnings.push("EXISTING_UNCONFIRMED_EVENTS_PRESERVED"); conflicts.push("EXISTING_EVENT_UNCONFIRMED") }
    for (const event of INSTALLED_HOOK_EVENTS) {
      if (options.support[event] !== "supported") continue
      const existing = beforeOwned.filter((item) => item.event === event)
      if (existing.length === 1 && fingerprintHandler(existing[0].handler) === fingerprintHandler(options.context.desiredHandler)) continue
      removeOwned(next, options.context, (name) => name === event, changes, existing.some((item) => fingerprintHandler(item.handler) !== fingerprintHandler(options.context.desiredHandler)) ? "REPLACE_PREVIOUS_COMMAND" : "REMOVE_DUPLICATE")
      next.hooks ??= {}
      const groups = next.hooks[event] ?? []
      next.hooks[event] = [...groups, { hooks: [structuredClone(options.context.desiredHandler)] }]
      changes.push({ event, operation: "add", reasonCode: "CURRENT_APP_COMMAND" })
    }
    if (Number(options.context.desiredHandler.timeout) === PACKAGED_HOOK_TIMEOUT_SECONDS) warnings.push("PACKAGED_TIMEOUT_2_SECONDS")
  } else if (options.action === "uninstall") {
    removeOwned(next, options.context, () => true, changes, "REMOVE_OWNED_HANDLER")
  } else {
    if (!options.revert) conflicts.push("NO_REVERSIBLE_RECEIPT")
    else if (ownedSignature(beforeOwned) !== ownedSignature(options.revert.afterOwned)) conflicts.push("OWNED_CHANGE_DIVERGED")
    else {
      removeOwned(next, options.context, () => true, changes, "REVERT_OWNED_CHANGE")
      const restoredGroups = new Map<string, HookGroup>()
      for (const placement of options.revert.beforeOwned) {
        next.hooks ??= {}
        if (!Object.hasOwn(next.hooks, placement.event)) Object.defineProperty(next.hooks, placement.event, { value: [], writable: true, enumerable: true, configurable: true })
        const key = `${placement.event}:${placement.groupIndex}`
        let group = restoredGroups.get(key)
        if (!group) {
          if (placement.pureGroup) {
            group = { hooks: [] }
            next.hooks[placement.event].splice(Math.min(placement.groupIndex, next.hooks[placement.event].length), 0, group)
          } else {
            const candidates = next.hooks[placement.event].filter((candidate) => groupMetadataFingerprint(candidate) === placement.groupMetadataFingerprint && containsInOrder(candidate.hooks.map(fingerprintHandler), placement.foreignSiblingFingerprints))
            if (candidates.length !== 1) { conflicts.push("REVERT_GROUP_DIVERGED"); continue }
            group = candidates[0]
          }
          restoredGroups.set(key, group)
        }
        group.hooks.splice(Math.min(placement.handlerIndex, group.hooks.length), 0, structuredClone(placement.handler))
        changes.push({ event: publicEvent(placement.event), operation: "restore", reasonCode: "RESTORE_PREVIOUS_OWNED_HANDLER" })
      }
    }
  }
  const changed = stableJson(file) !== stableJson(next)
  const serialized = changed ? `${JSON.stringify(next, null, 2)}\n` : options.before
  if (serialized !== null && Buffer.byteLength(serialized) > MAX_HOOK_FILE_BYTES) conflicts.push("RESULT_TOO_LARGE")
  if (changes.length > 256) conflicts.push("PLAN_TOO_COMPLEX")
  if (changed) warnings.push("JSON_WHITESPACE_MAY_CHANGE", "HOOK_REVIEW_REQUIRED")
  const contextForAfter = { ...options.context, receipts: [...(options.context.receipts ?? []), ...(options.revert?.beforeOwned.map((item) => handlerIdentity(item.handler)) ?? [])] }
  return {
    action: options.action, before: options.before,
    after: conflicts.length ? options.before : serialized,
    changed: changed && conflicts.length === 0,
    configurationStatus: inspection.status, changes, warnings: [...new Set(warnings)], conflicts: [...new Set(conflicts)],
    foreignHandlerCount: inspection.foreign, managedHandlerCount: inspection.managed,
    inverse: { beforeOwned, afterOwned: conflicts.length ? beforeOwned : ownedPlacements(next, contextForAfter) },
  }
}
