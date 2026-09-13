import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { hashText, type HookLaunchSpec } from "./HookLaunchSpec.ts"
import { allEventSupport, hookHandler, inspectHookConfiguration, planHookEdit, type ConfigurationStatus } from "./HookInstallPlan.ts"
import { parseHooksFile } from "./HookJson.ts"
import { HookInstallTransaction, canonicalCodexHome, readHookTarget } from "./HookInstallTransaction.ts"

export { HOOK_MARKER } from "./HookLaunchSpec.ts"
export { INSTALLED_HOOK_EVENTS } from "./HookInstallPlan.ts"

export type HookInstallResult = {
  action: "dry-run" | "apply" | "status" | "uninstall"
  path: string
  changed: boolean
  installed: boolean
  configurationStatus: ConfigurationStatus
  backupPath?: string
  // Compatibility for programmatic CLI consumers. Never log these snapshots
  // or expose them in the Settings preload or diagnostic export.
  before: string
  after: string
  changes: ReturnType<typeof planHookEdit>["changes"]
  foreignHandlersPreserved: number
  generatedCommand: string
}

/** Development CLI facade. Assisted packaged installation lives in Main and
 * requires a window-bound preview, a current host test and a support contract. */
export async function manageHooks(options: {
  action?: "dry-run" | "apply" | "status" | "uninstall"
  codexHome: string
  projectRoot: string
  nodePath?: string
  now?: () => Date
}): Promise<HookInstallResult> {
  const action = options.action ?? "dry-run"
  const codexHome = await canonicalCodexHome(options.codexHome)
  const spec: HookLaunchSpec = {
    mode: "development-node", executablePath: options.nodePath ?? process.execPath,
    forwarderPath: resolve(options.projectRoot, "adapter/codex/hooks/hook-forwarder.mjs"),
    dataDir: resolve(process.env.CODEX_PET_DATA_DIR ?? join(homedir(), ".codex-pet")),
    hookEndpoint: process.env.CODEX_PET_HOOK_URL ?? "http://127.0.0.1:4175/hook",
  }
  // Preserve the historical development command and Windows override. This is
  // never presented as successful packaged installation in the Settings UI.
  const desiredHandler = hookHandler(spec, true)
  const support = allEventSupport("supported")
  const storageRoot = join(codexHome, ".daemonlet-hook-installer")
  const installer = new HookInstallTransaction({
    codexHome, storageRoot, context: { desiredHandler }, support,
    now: options.now ? () => options.now!().getTime() : undefined,
    getBinding: async () => ({ targetPath: join(codexHome, "hooks.json"), hostFingerprint: hashText(JSON.stringify(spec)), configFingerprint: "development-cli", capabilityFingerprint: "development-compatibility-9-events", targetVersion: null, appVersion: "development", busy: false, blockers: [] }),
  })
  try {
    const snapshot = await readHookTarget(codexHome)
    const receipt = await installer.receipts()
    const context = { desiredHandler, receipts: receipt.identities }
    const inspection = inspectHookConfiguration(parseHooksFile(snapshot.before), context, support)
    const edit = planHookEdit({ action: action === "uninstall" ? "uninstall" : "install", before: snapshot.before, context, support })
    const result: HookInstallResult = {
      action, path: installer.target, changed: action === "status" ? false : edit.changed,
      installed: inspection.status === "installed-current", configurationStatus: inspection.status,
      before: snapshot.before ?? "{}\n", after: action === "status" ? snapshot.before ?? "{}\n" : edit.after ?? "{}\n",
      changes: action === "status" ? [] : edit.changes, foreignHandlersPreserved: inspection.foreign, generatedCommand: String(desiredHandler.command),
    }
    if (action === "status") return result
    if (edit.conflicts.length) throw new Error(`Hook configuration conflict: ${edit.conflicts.join(", ")}`)
    if (action === "apply" || action === "uninstall") {
      const plan = await installer.prepare(action === "apply" ? "install" : "uninstall", "development-cli")
      const applied = await installer.apply(plan.planId, "development-cli")
      if (applied.status === "committed-conflict") throw new Error("Hook change committed, but verification found a conflict; inspect the protected receipt")
      if (applied.changed && snapshot.before !== null) result.backupPath = join(storageRoot, `${plan.planId}.backup`)
      result.after = (await readHookTarget(codexHome)).before ?? "{}\n"
    }
    result.installed = action !== "uninstall"
    return result
  } finally { await installer.dispose() }
}
