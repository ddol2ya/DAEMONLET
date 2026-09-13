// This entire module is removed from production by __SETUP_SMOKE__ = false.
// Its test-only location/capability dependencies never come from renderer IPC.
import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { basename, join, sep } from "node:path"
import { createHookCommand, hashFile, HOOK_MARKER, HOOK_SYSTEM_PATH, legacyHookCommands, type HookLaunchSpec } from "../../adapter/codex/hooks/HookLaunchSpec"
import { allEventSupport, INSTALLED_HOOK_EVENTS } from "../../adapter/codex/hooks/HookInstallPlan"
import { HookSetupDoctor } from "../../adapter/codex/doctor/HookSetupDoctor"
import type { CodexIntegrationController } from "./CodexIntegrationController"
import type { SettingsWindowController } from "./SettingsWindowController"
import type { PetWindowController } from "./PetWindowController"
import type { AdapterSupervisor } from "./AdapterSupervisor"
import type { DesktopSettingsV1 } from "../shared/desktop-settings"
import type { HookPlanSummary, PublicSetupStatus } from "../shared/codex-integration-contract"
import { createSetupDiagnostics } from "./SetupDiagnostics"

type Controls = {
  settings: SettingsWindowController
  integration: CodexIntegrationController
  pet: PetWindowController
  adapter: AdapterSupervisor
  getDesktopSettings: () => DesktopSettingsV1
  quit: () => Promise<void>
}
export type SetupSmokeContext = {
  integrationOptions: Pick<ConstructorParameters<typeof CodexIntegrationController>[0], "doctor" | "testLocationPolicy">
  run: (controls: Controls) => Promise<void>
}

const waitFor = async (predicate: () => boolean | Promise<boolean>, code: string, timeout = 15000): Promise<void> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((done) => setTimeout(done, 70)) }
  throw new Error(`SMOKE_${code}`)
}

async function executeInstalled(command: string, expected: string, input: unknown): Promise<{ outputContract: boolean; wallTimeMs: number }> {
  assert.equal(command, expected, "SMOKE_INSTALLED_COMMAND_FACTORY_MATCH")
  const started = performance.now()
  return new Promise((done, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: "/", env: { PATH: HOOK_SYSTEM_PATH }, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(0, 4096) })
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(0, 4096) })
    child.stdin.on("error", () => {})
    child.once("error", () => { clearTimeout(timer); reject(new Error("SMOKE_COMMAND_HOST_UNAVAILABLE")) })
    child.once("close", (code) => { clearTimeout(timer); done({ outputContract: code === 0 && stdout === "{}\n" && stderr === "", wallTimeMs: Math.round(performance.now() - started) }) })
    child.stdin.end(JSON.stringify(input))
  })
}

export async function createSetupSmokeContext(): Promise<SetupSmokeContext> {
  if (!__SETUP_SMOKE__) throw new Error("SMOKE_BUILD_REQUIRED")
  const root = await realpath(process.env.SETUP_SMOKE_ROOT ?? "/missing-setup-smoke-root")
  assert(root.startsWith("/private/tmp/daemonlet-setup-smoke-"), "SMOKE_ISOLATED_ROOT_REQUIRED")
  const home = join(root, "codex-home"), userData = join(root, "userData"), dataDir = join(root, "adapter-data")
  const executable = join(root, "bin/codex")
  assert.equal(app.getPath("userData"), userData, "SMOKE_USERDATA_ISOLATION")
  assert.equal(process.env.CODEX_HOME, home, "SMOKE_CODEX_HOME_ISOLATION")
  assert.equal(process.env.CODEX_PET_DATA_DIR, dataDir, "SMOKE_ADAPTER_DATA_ISOLATION")
  assert.equal(process.env.CODEX_PATH, executable, "SMOKE_FAKE_CODEX_REQUIRED")
  const artifactSha256 = await hashFile(executable)
  const evidenceDirectory = process.env.SETUP_SMOKE_EVIDENCE_DIR!
  const pass = process.env.SETUP_SMOKE_PASS === "relaunch" ? "relaunch" : "fresh"
  const spec: HookLaunchSpec = { mode: "packaged-electron-node", executablePath: process.execPath, forwarderPath: join(process.resourcesPath, "codex/hook-forwarder.mjs"), dataDir, hookEndpoint: `http://127.0.0.1:${process.env.CODEX_PET_HOOK_PORT}/hook` }
  const doctor = new HookSetupDoctor({ policyPath: join(root, "requirements.toml"), contracts: [{
    id: "isolated-packaged-smoke", version: "codex-cli 0.147.0", artifactSha256,
    source: "test-fixture", surface: "synthetic", events: allEventSupport("supported"), featureKey: "hooks", eventTimeoutSeconds: 2,
  }] })
  return {
    integrationOptions: { doctor, testLocationPolicy: (value) => value.executablePath.startsWith(join(root, "standalone") + sep) && value.dataDir === dataDir },
    run: async (controls) => {
      const report: Record<string, unknown> = { source: "synthetic-packaged", status: "failed", pass, recordedAt: new Date().toISOString(), checks: {} }
      const checks = report.checks as Record<string, boolean>
      const check = (name: string, condition: unknown) => { checks[name] = Boolean(condition); assert(condition, `SMOKE_${name}`) }
      const evaluate = <T>(code: string): Promise<T> => new Promise((done, reject) => {
        const timer = setTimeout(() => reject(new Error("SMOKE_RENDERER_EVALUATION_TIMEOUT")), 10000)
        controls.settings.window!.webContents.executeJavaScript(code).then(
          value => { clearTimeout(timer); done(value as T) },
          error => { clearTimeout(timer); reject(error) },
        )
      })
      const getStatus = () => evaluate<PublicSetupStatus>("window.settingsDesktop.getStatus()")
      const snapshot = async (name: string) => {
        report.stage = `snapshot:${name}`
        await mkdir(evidenceDirectory, { recursive: true })
        // DOM assertions can finish before the compositor paints the new tab.
        // Wait for the actual renderer frame so evidence never shows its predecessor.
        await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60))))")
        const picture = await controls.settings.window!.webContents.capturePage()
        await writeFile(join(evidenceDirectory, `${name}.png`), picture.toPNG())
      }
      const click = async (text: string) => {
        report.stage = `click:${text}`
        await waitFor(() => evaluate<boolean>(`[...document.querySelectorAll('button')].some(item => (item.getAttribute('aria-label') ?? item.textContent).trim() === ${JSON.stringify(text)} && !item.disabled)`), "BUTTON_READY")
        const clicked = await evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent).trim() === ${JSON.stringify(text)}); if (!button || button.disabled) return false; for(let parent=button.parentElement;parent;parent=parent.parentElement) if(parent instanceof HTMLDetailsElement) parent.open=true; button.scrollIntoView({block:'center'}); button.click(); return true })()`)
        check(`button_${text}`, clicked)
      }
      const ready = async () => {
        report.stage = "settings-ready"
        await waitFor(() => Boolean(controls.settings.window && !controls.settings.window.isDestroyed()), "SETTINGS_WINDOW")
        await waitFor(async () => { try { return await evaluate<boolean>("!!window.settingsDesktop && document.querySelector('h1')?.textContent === 'Codex 연결'") } catch { return false } }, "SETTINGS_RENDERER")
        await controls.integration.refresh(true)
      }
      const fixture = { session_id: "synthetic-setup-session", turn_id: "synthetic-setup-turn", cwd: "/synthetic/workspace", model: "synthetic-model", permission_mode: "default", transcript_path: "/PRIVATE_TRANSCRIPT_CANARY", prompt: "PRIVATE_PROMPT_CANARY" }
      const closeListener = () => controls.settings.window?.webContents.removeAllListeners("console-message")
      try {
        await waitFor(() => controls.adapter.getStatus().state === "READY" && Boolean(controls.pet.window), "OWNED_ADAPTER_READY")
        if (pass === "fresh") {
          await ready()
          check("fresh_onboarding_shown", (await getStatus()).onboarding === "shown")
          await snapshot("01-first-run")
          await click("나중에")
          await waitFor(() => controls.settings.window === null, "SKIP_CLOSES_SETTINGS")
          check("skip_preserves_pet_and_adapter", !controls.pet.window!.isDestroyed() && controls.adapter.getStatus().state === "READY")
          controls.settings.open()
        } else {
          check("relaunch_does_not_reopen_onboarding", controls.settings.window === null)
          controls.settings.open()
        }
        await ready()
        const win = controls.settings.window!
        let privateConsole = false
        win.webContents.on("console-message", (details) => { if (details.message.includes("PRIVATE_")) privateConsole = true })
        check("exact_packaged_settings_url", win.webContents.getURL() === "pet://app/settings.html")
        const preferences = (win.webContents as typeof win.webContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
        check("settings_sandbox_and_isolation", preferences.nodeIntegration === false && preferences.contextIsolation === true && preferences.sandbox === true && preferences.webSecurity === true && preferences.webviewTag === false)
        check("settings_has_no_pet_lab_canvas_or_protocol", await evaluate<boolean>("!window.petDesktop && !window.motionLabDesktop && !document.querySelector('canvas') && !window.settingsDesktop.protocol && !window.settingsDesktop.invoke"))
        check("skip_is_not_connection_success", (await getStatus()).onboarding === "skipped" && (await getStatus()).live.status === "not-tested")
        check("manual_checks_hidden_on_default_connection_page", await evaluate<boolean>("!document.querySelector('.setup-advanced[open]') && !document.querySelector('#observation-surface').checkVisibility()"))
        const hooksBeforePreparation = await readFile(join(home, "hooks.json"), "utf8")
        await click(pass === "fresh" ? "연결 준비" : "연결 확인")
        await waitFor(async () => (await getStatus()).hostSelfTest.status === "passed", "HOST_SELFTEST")
        await waitFor(() => evaluate<boolean>("document.querySelector('.operation-status')?.textContent === ''"), "SELFTEST_UI_SETTLED")
        check("selftest_does_not_increment_live_evidence", (await getStatus()).live.events.every((item) => item.count === 0) && (await getStatus()).live.desktopStopAttempt === "not-tested" && (await getStatus()).reception.status === "waiting")
        check("one_click_preparation_preserves_hooks_and_review", await readFile(join(home, "hooks.json"), "utf8") === hooksBeforePreparation && !(await getStatus()).live.active && (await getStatus()).hookReviewStatus !== "user-reported-reviewed")
        if (pass === "fresh") {
          await waitFor(() => evaluate<boolean>("!!document.querySelector('dialog[open]')"), "PREVIEW_VISIBLE")
          check("preview_redacts_foreign_commands", !(await evaluate<string>("document.body.innerText")).includes("PRIVATE_"))
          await snapshot("02-install-preview")
          await click("변경을 확인했으며 적용")
          await waitFor(async () => (await getStatus()).configurationStatus === "installed-current", "INSTALL_APPLIED")
          await waitFor(() => evaluate<boolean>("!document.querySelector('dialog[open]')"), "PREVIEW_CLOSED")
        }
        check("installed_is_not_trusted_or_observed", (await getStatus()).hookReviewStatus !== "user-reported-reviewed" && (await getStatus()).live.status === "not-tested")
        const noOpBefore = await readFile(join(home, "hooks.json"), "utf8")
        const noOp = await evaluate<HookPlanSummary>("window.settingsDesktop.planHooks('install')")
        check("reinstall_is_noop", noOp.canApply && !noOp.changed)
        await evaluate(`window.settingsDesktop.applyHookPlan(${JSON.stringify(noOp.planId)})`)
        check("reinstall_preserves_bytes", await readFile(join(home, "hooks.json"), "utf8") === noOpBefore)
        const installed = JSON.parse(noOpBefore)
        const installedCommand = installed.hooks.UserPromptSubmit[0].hooks[0].command as string
        check("packaged_command_has_no_dev_or_external_node", installedCommand === createHookCommand(spec) && !installedCommand.includes("Cellar") && !installedCommand.includes("node_modules") && installedCommand.includes("/standalone/"))
        const windowCount = BrowserWindow.getAllWindows().length
        let secondInstances = 0
        const onSecondInstance = () => { secondInstances++ }
        app.on("second-instance", onSecondInstance)
        await evaluate("window.settingsDesktop.updateSettings({visible:false})")
        const promptResult = await executeInstalled(installedCommand, createHookCommand(spec), { ...fixture, hook_event_name: "UserPromptSubmit" })
        const stopResult = await executeInstalled(installedCommand, createHookCommand(spec), { ...fixture, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "PRIVATE_ASSISTANT_CANARY" })
        await controls.adapter.requestFreshDiagnostics()
        check("actual_generated_command_delivers_synthetic_events", promptResult.outputContract && stopResult.outputContract && (controls.adapter.getDiagnostics().hookEvents?.find((item) => item.event === "Stop")?.count ?? 0) > 0)
        check("hook_does_not_open_gui_or_show_hidden_pet", BrowserWindow.getAllWindows().length === windowCount && !controls.pet.window!.isVisible() && secondInstances === 0)
        app.removeListener("second-instance", onSecondInstance)
        await evaluate("window.settingsDesktop.updateSettings({visible:true})")
        check("synthetic_command_is_not_reported_as_actual_codex", (await getStatus()).live.status === "not-tested")
        check("receipts_update_without_manual_observation", (await getStatus()).reception.status === "receiving" && !(await getStatus()).live.active)
        await waitFor(() => evaluate<boolean>("document.querySelector('.connection-heading h2')?.textContent === '연결됨'"), "AUTOMATIC_RECEIPT_UI")
        await snapshot("automatic-receipts")
        check("private_body_not_persisted", !(await readFile(join(dataDir, "adapter-state.json"), "utf8")).includes("PRIVATE_"))
        await writeFile(join(root, "installed-command.json"), JSON.stringify({ command: installedCommand }), { mode: 0o600 })
        if (pass === "relaunch") {
          const saved = JSON.parse(await readFile(join(root, "saved-desktop-settings.json"), "utf8")) as DesktopSettingsV1
          const current = controls.getDesktopSettings()
          check("appearance_restored_after_relaunch", current.characterId === saved.characterId && current.scale === saved.scale && current.speechBubblesEnabled === saved.speechBubblesEnabled && current.alwaysOnTop === saved.alwaysOnTop && current.clickThrough === saved.clickThrough)
          const legacyPath = join(root, "legacy project/adapter/codex/hooks/hook-forwarder.mjs")
          await mkdir(join(root, "legacy project/adapter/codex/hooks"), { recursive: true, mode: 0o700 })
          await copyFile(spec.forwarderPath, legacyPath)
          const legacyNode = await realpath(process.env.SETUP_SMOKE_LEGACY_NODE_PATH!)
          check("legacy_fixture_uses_explicit_node_path", basename(legacyNode) === "node")
          const legacy = { type: "command", ...legacyHookCommands(legacyNode, legacyPath), timeout: 1 }
          const legacyFile = JSON.parse(await readFile(join(home, "hooks.json"), "utf8"))
          for (const event of INSTALLED_HOOK_EVENTS) for (const group of legacyFile.hooks[event]) group.hooks = group.hooks.map((handler: Record<string, unknown>) => handler.command === installedCommand ? legacy : handler)
          legacyFile.hooks.Stop[0].hooks.splice(1, 0, legacy)
          legacyFile.hooks.Stop = legacyFile.hooks.Stop.filter((group: { hooks: Array<Record<string, unknown>> }, index: number) => index === 0 || !group.hooks.every((handler) => handler.command === legacy.command))
          await writeFile(join(home, "hooks.json"), JSON.stringify(legacyFile), { mode: 0o600 })
          await controls.integration.refresh(true)
          check("legacy_detected", (await getStatus()).configurationStatus === "installed-legacy")
          await click("수리 미리보기")
          await waitFor(() => evaluate<boolean>("!!document.querySelector('dialog[open]')"), "REPAIR_PREVIEW")
          check("legacy_preview_is_structural_and_private", !(await evaluate<string>("document.body.innerText")).includes("PRIVATE_"))
          await snapshot("04-repair-preview")
          await click("변경을 확인했으며 적용")
          await waitFor(async () => (await getStatus()).configurationStatus === "installed-current", "REPAIR_APPLIED")
          await waitFor(() => evaluate<boolean>("!document.querySelector('dialog[open]')"), "REPAIR_UI_SETTLED")
          const afterRepair = JSON.parse(await readFile(join(home, "hooks.json"), "utf8"))
          check("repair_preserves_mixed_foreign_siblings", afterRepair.hooks.Stop[0].hooks.length === 2 && afterRepair.hooks.Stop[0].description === "PRIVATE_GROUP_CANARY")
          afterRepair.hooks.Stop[0].hooks.push({ type: "command", command: "PRIVATE_LATER_FOREIGN_CANARY" })
          afterRepair.laterMetadata = { preserved: true }
          await writeFile(join(home, "hooks.json"), JSON.stringify(afterRepair), { mode: 0o600 })
          await controls.integration.refresh(true)
          await click("마지막 변경 되돌리기")
          await waitFor(() => evaluate<boolean>("!!document.querySelector('dialog[open]')"), "REVERT_PREVIEW")
          await click("변경을 확인했으며 적용")
          await waitFor(() => evaluate<boolean>("!document.querySelector('dialog[open]')"), "REVERT_APPLIED")
          const reverted = JSON.parse(await readFile(join(home, "hooks.json"), "utf8"))
          check("revert_keeps_later_foreign_change", reverted.hooks.Stop[0].hooks.map((item: Record<string, unknown>) => item.command).join("|") === ["PRIVATE_FOREIGN_A_CANARY", legacy.command, "PRIVATE_FOREIGN_B_CANARY", "PRIVATE_LATER_FOREIGN_CANARY"].join("|") && reverted.laterMetadata.preserved === true)
          reverted.hooks.FutureEvent = [{ hooks: [legacy, { type: "command", command: "PRIVATE_FUTURE_FOREIGN_CANARY" }] }]
          await writeFile(join(home, "hooks.json"), JSON.stringify(reverted), { mode: 0o600 })
          const tokenBefore = await readFile(join(dataDir, "adapter-token"), "utf8")
          await click("연동 제거")
          await waitFor(() => evaluate<boolean>("!!document.querySelector('dialog[open]')"), "UNINSTALL_PREVIEW")
          await snapshot("05-uninstall-preview")
          await click("변경을 확인했으며 적용")
          await waitFor(() => evaluate<boolean>("!document.querySelector('dialog[open]')"), "UNINSTALL_APPLIED")
          const removed = JSON.parse(await readFile(join(home, "hooks.json"), "utf8"))
          check("uninstall_preserves_foreign_siblings_metadata_and_unknown_events", removed.hooks.Stop[0].hooks.map((item: Record<string, unknown>) => item.command).join("|") === "PRIVATE_FOREIGN_A_CANARY|PRIVATE_FOREIGN_B_CANARY|PRIVATE_LATER_FOREIGN_CANARY" && removed.hooks.FutureEvent[0].hooks.length === 1 && removed.laterMetadata.preserved === true)
          check("uninstall_does_not_delete_token_or_data", await readFile(join(dataDir, "adapter-token"), "utf8") === tokenBefore)
          check("config_toml_untouched", await readFile(join(home, "config.toml"), "utf8") === "# isolated setup smoke\n[features]\nhooks = true\n")
          const stale = await evaluate<HookPlanSummary>("window.settingsDesktop.planHooks('install')")
          const externallyEdited = { ...removed, userEditAfterPreview: true }
          await writeFile(join(home, "hooks.json"), JSON.stringify(externallyEdited), { mode: 0o600 })
          check("stale_preview_rejected_by_main", await evaluate<boolean>(`window.settingsDesktop.applyHookPlan(${JSON.stringify(stale.planId)}).then(() => false, error => error.message === 'PLAN_STALE')`))
          check("stale_preview_preserves_user_edit", JSON.parse(await readFile(join(home, "hooks.json"), "utf8")).userEditAfterPreview === true)
        }
        await click("캐릭터·표시")
        await waitFor(() => evaluate<boolean>("document.querySelector('h1')?.textContent === '캐릭터·표시'"), "APPEARANCE_PAGE")
        for (const characterId of ["gpichan"]) {
          await waitFor(() => evaluate<boolean>(`!document.querySelector('input[name="character"][value="${characterId}"]').disabled`), "CHARACTER_CONTROL_READY")
          await evaluate(`document.querySelector('input[name="character"][value="${characterId}"]').click()`)
          await waitFor(() => controls.getDesktopSettings().characterId === characterId, "CHARACTER_MAIN_UPDATED")
          check(`character_${characterId}_main_sync`, controls.getDesktopSettings().characterId === characterId)
        }
        await waitFor(() => evaluate<boolean>("document.querySelector('.operation-status')?.textContent === ''"), "APPEARANCE_SETTLED")
        await evaluate("window.settingsDesktop.updateSettings({scale:0.8,alwaysOnTop:false,speechBubblesEnabled:false,clickThrough:false})")
        await waitFor(() => evaluate<boolean>("document.querySelector('#character-scale')?.value === '0.8'"), "SETTINGS_BROADCAST")
        check("appearance_uses_single_store", controls.getDesktopSettings().speechBubblesEnabled === false && controls.getDesktopSettings().scale === 0.8)
        await snapshot("03-appearance")
        await writeFile(join(root, "saved-desktop-settings.json"), JSON.stringify(controls.getDesktopSettings()), { mode: 0o600 })
        await click("진단")
        await waitFor(() => evaluate<boolean>("document.querySelector('h1')?.textContent === '진단'"), "DIAGNOSTICS_PAGE")
        check("dom_and_export_are_private", !(await evaluate<string>("document.body.innerText")).includes("PRIVATE_") && !JSON.stringify(createSetupDiagnostics(await getStatus())).includes("PRIVATE_"))
        await snapshot("06-diagnostics")
        for (let index = 0; index < 3; index++) {
          const before = controls.settings.window!
          check(`window_reuse_${index}`, controls.settings.open() === before && BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() === 'pet://app/settings.html').length === 1)
          const pending = await evaluate<HookPlanSummary>("window.settingsDesktop.planHooks('uninstall')")
          before.close()
          await waitFor(() => controls.settings.window === null, "SETTINGS_CLOSED")
          check(`close_preserves_pet_adapter_${index}`, !controls.pet.window!.isDestroyed() && controls.adapter.getStatus().state === "READY" && BrowserWindow.getAllWindows().every(window => window.webContents.getURL() !== 'pet://app/settings.html'))
          controls.settings.open()
          await ready()
          check(`closed_frame_plan_revoked_${index}`, await evaluate<boolean>(`window.settingsDesktop.applyHookPlan(${JSON.stringify(pending.planId)}).then(() => false, error => ['PLAN_UNKNOWN','PLAN_OWNER_MISMATCH'].includes(error.message))`))
        }
        check("no_private_console_output", !privateConsole)
        report.status = "passed"
      } catch (error) { report.failure = error instanceof Error && error.message.startsWith("SMOKE_") ? error.message.split("\n")[0] : "SMOKE_UNEXPECTED_FAILURE" }
      finally {
        closeListener()
        report.diagnostics = createSetupDiagnostics(controls.integration.getStatus())
        await writeFile(join(root, `${pass}-result.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
        await writeFile(join(root, `${pass}-processes.json`), JSON.stringify(app.getAppMetrics().map((metric) => metric.pid)), { mode: 0o600 })
        await controls.quit()
      }
    },
  }
}
