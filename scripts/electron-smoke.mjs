import electronPath from "electron"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { startSmokeDesktopPresence } from "./smoke-desktop-presence.mjs"

const root = resolve(import.meta.dirname, "..")
const evidenceDirectory = resolve(process.env.ELECTRON_SMOKE_EVIDENCE_DIRECTORY ?? join(root, "outputs/evidence/electron-desktop-pet"))
const bellEvidenceDirectory = resolve(process.env.ELECTRON_SMOKE_BELL_DIRECTORY ?? join(root, "outputs/evidence/bell-character/electron"))
const adapterMode = process.env.ELECTRON_SMOKE_ADAPTER_MODE ?? "owned"
const forceTrayOffscreen = process.env.ELECTRON_SMOKE_FORCE_TRAY_OFFSCREEN === "1"
const dialogueEvidence = process.env.ELECTRON_SMOKE_DIALOGUE_EVIDENCE
const hybridEvidence = process.env.ELECTRON_SMOKE_HYBRID_EVIDENCE
const officialReview = process.env.ELECTRON_SMOKE_OFFICIAL_READONLY === 'fresh-approval-four-submissions'
if (process.env.ELECTRON_SMOKE_OFFICIAL_OUTPUT && (!officialReview || !process.env.ELECTRON_SMOKE_OFFICIAL_HOME || !process.env.ELECTRON_SMOKE_OFFICIAL_CLI || !process.env.ELECTRON_SMOKE_OFFICIAL_PARENT)) throw Error('Fresh official side-chat review scope is required')
const activityEvidence = process.env.ELECTRON_SMOKE_ACTIVITY_EVIDENCE
const recoveryLifecycle = process.env.ELECTRON_SMOKE_RECOVERY === "1"
if (adapterMode !== "owned" && adapterMode !== "external") throw new Error(`Unsupported ELECTRON_SMOKE_ADAPTER_MODE: ${adapterMode}`)
if (recoveryLifecycle && (adapterMode !== "owned" || forceTrayOffscreen)) throw new Error("Recovery smoke requires owned mode without the Tray override")
if (activityEvidence && (adapterMode !== "owned" || recoveryLifecycle || dialogueEvidence)) throw new Error("Activity smoke requires its own isolated owned run")
const resultPath = dialogueEvidence ? join(tmpdir(), `daemonlet-dialogue-smoke-${process.pid}.json`) : resolve(evidenceDirectory, recoveryLifecycle ? "recovered-run-confirmation.json" : forceTrayOffscreen ? "dock-activate-recovery.json" : adapterMode === "owned" ? "smoke-test-owned.json" : "smoke-test-external.json")
await mkdir(dialogueEvidence || evidenceDirectory, { recursive: true })

const getFreePort = () => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (!address || typeof address === "string") return reject(new Error("Failed to allocate a loopback port"))
    const port = address.port
    server.close((error) => error ? reject(error) : resolvePort(port))
  })
})

const isPortReleased = (port) => new Promise((resolveReleased) => {
  const server = createServer()
  server.once("error", () => resolveReleased(false))
  server.listen(port, "127.0.0.1", () => server.close((error) => resolveReleased(!error)))
})

const smokeUserData = await mkdtemp(join(tmpdir(), "daemonlet-electron-smoke-user-"))
const smokeAdapterData = await mkdtemp(join(tmpdir(), "daemonlet-electron-smoke-adapter-"))
if (process.env.ELECTRON_SMOKE_CHARACTER_STORE) await cp(resolve(process.env.ELECTRON_SMOKE_CHARACTER_STORE), join(smokeUserData, "characters"), { recursive: true })
// This existing runtime smoke tests a returning user. Fresh onboarding has its
// own setup:smoke; there is no production flag that silently skips onboarding.
await writeFile(join(smokeUserData, "codex-integration.json"), JSON.stringify({ version: 1, onboarding: "skipped", selection: { executablePath: null, codexHome: process.env.ELECTRON_SMOKE_LIVE_SIDE_CHAT === "user-authorized-six-requests" ? process.env.ELECTRON_SMOKE_LIVE_AUTH_HOME ?? null : null }, reviewedFingerprint: null }), { mode: 0o600 })
if (officialReview) await writeFile(join(smokeUserData, "codex-integration.json"), JSON.stringify({ version: 1, onboarding: "skipped", selection: { executablePath: process.env.ELECTRON_SMOKE_OFFICIAL_CLI, codexHome: process.env.ELECTRON_SMOKE_OFFICIAL_HOME }, reviewedFingerprint: null }), { mode: 0o600 })
if (activityEvidence) {
  const at = Date.now() - 30_000
  await mkdir(join(smokeUserData, "activity"), { mode: 0o700 })
  await writeFile(join(smokeUserData, "activity/history.json"), JSON.stringify({
    version: 1, nextId: 2, droppedUnread: 0, lastPrunedAt: null, capacityLimited: false, tombstones: [],
    records: [{ key: createHash("sha256").update("codex-adapter\0fixture-failure").digest("hex"), activityId: "activity-1", state: "failed", revision: 2, firstObservedAt: at, lastObservedAt: at, eventAt: at, endedAt: at, acknowledgedAt: null, confidence: null, category: null }],
  }), { mode: 0o600 })
}
const isolatedPresence = process.platform === "win32" || Boolean(dialogueEvidence || hybridEvidence || process.env.ELECTRON_SMOKE_SIDE_CHAT_PACKS || process.env.ELECTRON_SMOKE_LIVE_SIDE_CHAT_EVIDENCE || officialReview)
const shortCodexHome = process.env.ELECTRON_SMOKE_DESKTOP_CONTROL_EVIDENCE || isolatedPresence
const smokeCodexHome = shortCodexHome
  ? await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "2dl-desktop-home-"))
  : join(smokeUserData, "codex-home")
const smokeCodexExecutable = join(smokeUserData, "fake-codex")
await mkdir(smokeCodexHome, { recursive: true, mode: 0o700 })
await writeFile(smokeCodexExecutable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.0.0\\n'; else exit 1; fi\n", { mode: 0o700 })
let protocolPort
let hookPort
if (adapterMode === "owned") {
  protocolPort = await getFreePort()
  do { hookPort = await getFreePort() } while (hookPort === protocolPort)
}
if (recoveryLifecycle) {
  const updatedAt = Date.now() - 1_000
  const run = (turnId) => ({
    sessionId: "smoke-recovery-session",
    turnId,
    backend: "HOOK_OBSERVER",
    startedAt: updatedAt - 1_000,
    updatedAt,
    tasks: [],
  })
  await writeFile(join(smokeAdapterData, "adapter-state.json"), `${JSON.stringify({
    schemaVersion: 1,
    source: { name: "codex-adapter" },
    registry: { runs: [run("smoke-unconfirmed-turn"), run("smoke-confirmed-turn")] },
    updatedAt,
  }, null, 2)}\n`, { mode: 0o600 })
}

const packagedExecutable = process.env.ELECTRON_SMOKE_EXECUTABLE
const executable = packagedExecutable || electronPath
const scaleFactor = process.env.ELECTRON_SMOKE_DEVICE_SCALE_FACTOR
if (scaleFactor && !["1", "2"].includes(scaleFactor)) throw new Error("Smoke scale factor must be 1 or 2")
const args = [...(packagedExecutable ? [] : [resolve(root, "dist-electron/main.cjs")]), ...(scaleFactor ? [`--force-device-scale-factor=${scaleFactor}`] : [])]
let stdout = ""
let stderr = ""
let result
const smokeEnvironment = {
  ...process.env,
  ELECTRON_SMOKE_TEST: "1", ELECTRON_SMOKE_RESULT: resultPath,
  ELECTRON_SMOKE_USER_DATA: smokeUserData, ELECTRON_SMOKE_ADAPTER_MODE: adapterMode,
  CODEX_PET_DATA_DIR: smokeAdapterData, CODEX_PATH: smokeCodexExecutable, CODEX_HOME: smokeCodexHome,
  ...(recoveryLifecycle ? { CODEX_PET_RECOVERY_TTL_MS: "10000" } : {}),
  ...(protocolPort ? { CODEX_PET_PROTOCOL_PORT: String(protocolPort) } : {}),
  ...(hookPort ? { CODEX_PET_HOOK_PORT: String(hookPort) } : {}),
}

// An empty temporary home has no desktop broker. Keep source presence alive
// after synthetic Hook turns end, so completion/touch poses can be verified.
const stopPresence = isolatedPresence ? await startSmokeDesktopPresence(smokeCodexHome) : null

try {
  const child = spawn(executable, args, {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: smokeEnvironment,
  })
  child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk) })
  child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk) })
  let timedOut = false
  const requestedNativeWait = Number(process.env.ELECTRON_SMOKE_NATIVE_WAIT_MS ?? 60000)
  const nativeWaitMs = Number.isFinite(requestedNativeWait) ? Math.max(60000, Math.min(300000, requestedNativeWait)) : 60000
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, process.env.ELECTRON_SMOKE_NATIVE_CLICK === "1" ? 240_000 + 2 * nativeWaitMs : dialogueEvidence || activityEvidence || hybridEvidence || process.env.ELECTRON_SMOKE_LIVE_SIDE_CHAT_EVIDENCE || officialReview ? 420_000 : 120_000)
  const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit) })
  clearTimeout(timeout)
  if (timedOut) throw new Error(`Electron smoke timed out before completion\n${stderr.slice(-4000)}`)
  if (code !== 0) throw new Error(`Electron smoke failed with exit ${String(code)}\n${stderr.slice(-4000)}`)

  result = JSON.parse(await readFile(resultPath, "utf8"))
  if (officialReview && result.officialReadOnlyValidation?.status !== "LIVE_UI_PASS") throw new Error("Official real-account review did not fully pass; inspect the separate result")
  if (process.env.ELECTRON_SMOKE_LIVE_SIDE_CHAT_EVIDENCE && result.liveSideChatValidation?.status !== "PASS") throw new Error("Packaged live side chat did not fully pass; inspect live-result.json")
  if (process.env.ELECTRON_SMOKE_SIDE_CHAT_EVIDENCE && result.sideChatValidation?.status !== "PASS") throw new Error("Packaged side chat gate failed")
  if (process.env.ELECTRON_SMOKE_SIDE_CHAT_PACKS && result.sideChatPackValidation?.status !== "PASS") throw new Error("Side chat pack switch smoke failed")
  const activityHistory = JSON.parse(await readFile(join(smokeUserData, "activity/history.json"), "utf8"))
  result.activityHistory = {
    schemaVersion: activityHistory.version,
    states: Object.fromEntries(["running", "waiting", "completed", "failed", "cancelled", "unknown"].map(state => [state, activityHistory.records.filter(r => r.state === state).length])),
  }
  if (recoveryLifecycle) {
    const persisted = JSON.parse(await readFile(join(smokeAdapterData, "adapter-state.json"), "utf8"))
    result.recoveryValidation.persistedStateEmpty = persisted.registry.runs.length === 0
    result.recoveryValidation.testRecoveryTtlMs = 10_000
    result.recoveryValidation.oldRunRevivedAfterFinalPersistence = persisted.registry.runs.length !== 0
  }
  const cleanup = adapterMode === "owned" ? {
    protocolPortReleased: await isPortReleased(protocolPort),
    hookPortReleased: await isPortReleased(hookPort),
  } : { protocolPortReleased: null, hookPortReleased: null }
  result.cleanup = cleanup
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")

  const baseValid = result.appReady
    && result.petWindowCreated
    && result.preloadLoaded
    && result.webgl
    && result.characterId === "gpichan"
    && result.characterReloadCount === 3
    && result.characterReloadFailures.length === 0
    && result.characterSelections?.length === 1
    && result.characterSelections.every(item => item.ready)
    && result.characterSelections.every(item => item.id === "gpichan")
    && result.retiredCharactersRejected
    && (!result.bellEvidenceCapture || result.characterId !== "bell" || Object.values(result.bellEvidenceCapture).every(Boolean))
    && result.alphaClickThrough.transparentPasses
    && result.alphaClickThrough.opaqueInteractive
    && result.alphaClickThrough.transparentRelease
    && result.alphaClickThrough.captureLossUnlock
    && result.alphaClickThrough.layoutLock
    && result.visibilitySync.closeHidden
    && result.visibilitySync.settingFalse
    && result.visibilitySync.persistedFalse
    && result.visibilitySync.petHiddenBeforeActivate
    && result.visibilitySync.dockActivateShowedPet
    && result.visibilitySync.visiblePersistedTrue
    && result.trayCreated
    && result.packagedResourcesPresent
    && (forceTrayOffscreen
      ? result.warnings.length === 1 && result.warnings[0].startsWith("macOS did not place the menu-bar item")
      : result.warnings.length === 0)
  if (dialogueEvidence && (!result.dialogueValidation || result.dialogueValidation.warnings.length)) throw new Error(`Dialogue smoke did not complete: ${result.warnings.filter((warning) => warning.startsWith("Dialogue ")).join("; ")}`)
  if (hybridEvidence && !result.hybridValidation) throw new Error(`Hybrid smoke did not complete: ${result.warnings.join("; ")}`)
  if (process.env.ELECTRON_SMOKE_TASK_CONTROL_EVIDENCE && !result.taskControlValidation) throw new Error("Task control smoke did not complete")
  if (process.env.ELECTRON_SMOKE_DESKTOP_CONTROL_EVIDENCE && !result.desktopControlValidation) throw new Error("Desktop control smoke did not complete")
  if (process.env.ELECTRON_SMOKE_RESTART_EVIDENCE && !result.activityValidation?.restartValidation) throw new Error("Restart detection smoke did not complete")
  if (process.env.ELECTRON_SMOKE_RESULT_OPEN_EVIDENCE && !result.activityValidation?.resultOpenValidation) throw new Error("Result open smoke did not complete")
  if (!baseValid) throw new Error(`Electron smoke assertions failed: ${JSON.stringify(result)}`)
  if (process.env.ELECTRON_SMOKE_BELL_EVIDENCE) {
    for (const id of ["gpichan"]) {
      const capture = await readFile(join(process.env.ELECTRON_SMOKE_BELL_EVIDENCE, `${id}-selected.png`))
      if (capture.length < 100 || capture.subarray(1, 4).toString() !== "PNG") throw new Error(`Missing character capture: ${id}`)
    }
  }
  if (forceTrayOffscreen) {
    const dockRecoveryValid = result.packaged
      && result.trayOffscreenDetected
      && result.dockPolicyRestored
      && result.petHiddenBeforeActivate
      && result.dockActivateShowedPet
      && result.visibleSetting
      && result.trayLabel === (result.language === "en" ? "Hide character" : "캐릭터 숨기기")
    if (!dockRecoveryValid) throw new Error(`Dock recovery smoke assertions failed: ${JSON.stringify(result)}`)
  }
  if (recoveryLifecycle) {
    const recovery = result.recoveryValidation
    const recoveryValid = recovery
      && recovery.productionRecoveryTtlMs === 120000
      && recovery.testRecoveryTtlMs === 10000
      && recovery.recentRunsRestoredProvisionally
      && recovery.utilityCrashTriggered
      && recovery.utilityRestartObserved
      && recovery.runsRestoredProvisionallyAfterCrash
      && recovery.unknownChildCompletionAccepted
      && recovery.unknownChildCompletionConfirmedRun
      && recovery.unconfirmedRunExpired
      && recovery.cancelReason === "recovery-not-confirmed"
      && recovery.confirmedRunUsesNormalStaleTtl
      && recovery.confirmedRunInterruptAccepted
      && recovery.finalActiveRunCount === 0
      && recovery.persistedStateEmpty
      && recovery.oldRunRevivedAfterFinalPersistence === false
      && recovery.rawIdsInWarnings === false
    if (!recoveryValid) throw new Error(`Recovered Run smoke assertions failed: ${JSON.stringify(result)}`)
  }
  if (packagedExecutable && !result.packaged) throw new Error("Packaged smoke launched an unpackaged Electron runtime")
  if (adapterMode === "owned") {
    const ownedValid = result.adapterSupervisorState === "READY"
      && result.adapterOwnership === "OWNED_UTILITY"
      && result.externalAdapterReused === false
      && result.adapterProtocolEndpoint === `ws://127.0.0.1:${protocolPort}/events`
      && result.adapterHookEndpoint === `http://127.0.0.1:${hookPort}/hook`
      && result.protocolConnectionState === "READY"
      && result.protocolSource === "codex-adapter"
      && result.protocolSnapshotCount >= 1
      && result.motionLabProtocolReady
      && result.petConnectionSurvivedLabClose
      && result.protocolBridgeClients === 1
      && cleanup.protocolPortReleased
      && cleanup.hookPortReleased
    if (!ownedValid) throw new Error(`Owned adapter smoke assertions failed: ${JSON.stringify(result)}`)
  }
  if (adapterMode === "external") {
    const externalValid = result.adapterSupervisorState === "EXTERNAL_RUNNING"
      && result.adapterOwnership === "EXTERNAL_PROCESS"
      && result.externalAdapterReused === true
      && result.protocolConnectionState === "READY"
      && result.protocolSource === "codex-adapter"
      && result.motionLabProtocolReady
      && result.petConnectionSurvivedLabClose
    if (!externalValid) throw new Error(`External adapter smoke assertions failed: ${JSON.stringify(result)}`)
  }
  if (!stdout.includes("ELECTRON_SMOKE_RESULT")) throw new Error("Electron smoke result marker was not emitted")
  if (activityEvidence) {
    if (!result.activityValidation) throw new Error("Activity smoke did not complete")
    // Lose only the isolated Adapter registry to model an offline gap. The app's
    // separate Activity history must survive, with active outcomes now unknown.
    await rm(join(smokeAdapterData, "adapter-state.json"), { force: true })
    const restorePath = resolve(activityEvidence, "restart-state.json")
    const restarted = spawn(executable, args, { cwd: root, shell: false, stdio: ["ignore", "ignore", "pipe"], env: { ...smokeEnvironment, ELECTRON_SMOKE_ACTIVITY_PHASE: "restore", ELECTRON_SMOKE_RESULT: restorePath } })
    restarted.stderr.on("data", chunk => process.stderr.write(chunk))
    const restoreTimer = setTimeout(() => restarted.kill("SIGTERM"), 90_000)
    const restoreCode = await new Promise((resolveExit, reject) => { restarted.once("exit", resolveExit); restarted.once("error", reject) }).finally(() => clearTimeout(restoreTimer))
    if (restoreCode !== 0) throw new Error("Activity restart exited unexpectedly")
    const restored = JSON.parse(await readFile(restorePath, "utf8"))
    if (!restored.restored) throw new Error("Activity restart assertions failed")
    for (const before of result.activityValidation.retained) {
      const after = restored.entries.find(r => r.activityId === before.activityId)
      const expectedState = ["running", "waiting"].includes(before.state) ? "unknown" : before.state
      if (!after || after.state !== expectedState || after.unread !== before.unread) throw new Error("Activity history changed unexpectedly across restart")
    }
    if (!await isPortReleased(protocolPort) || !await isPortReleased(hookPort)) throw new Error("Activity restart leaked a port")
    result.activityValidation.appRestartPreservesResults = true
    result.activityValidation.offlineMissingRunUnknown = true
    result.activityValidation.screenshots.push("activity-restarted.png")
    await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n")
    await writeFile(resolve(activityEvidence, "packaged-smoke.json"), JSON.stringify({ packaged: result.packaged, ...result.activityValidation, cleanup: result.cleanup }, null, 2) + "\n")
    process.stdout.write("ACTIVITY_SMOKE_PASSED package, restart, storage, IPC and isolated Hook scenarios\n")
  }
  if (dialogueEvidence) await writeFile(resolve(dialogueEvidence, "packaged-smoke.json"), `${JSON.stringify({
    packaged: result.packaged,
    desktop: {
      characterSwitchCount: result.characterSwitchCount,
      characterSwitchFailures: result.characterSwitchFailures,
      packagedResourcesPresent: result.packagedResourcesPresent,
      adapterSupervisorState: result.adapterSupervisorState,
      adapterOwnership: result.adapterOwnership,
      protocolConnectionState: result.protocolConnectionState,
      protocolSource: result.protocolSource,
      protocolSnapshotCount: result.protocolSnapshotCount,
      protocolBridgeClients: result.protocolBridgeClients,
      motionLabProtocolReady: result.motionLabProtocolReady,
      petConnectionSurvivedLabClose: result.petConnectionSurvivedLabClose,
      alphaClickThrough: result.alphaClickThrough,
      visibilitySync: result.visibilitySync,
    },
    ...result.dialogueValidation, cleanup: result.cleanup,
  }, null, 2)}\n`, "utf8")
} finally {
  await stopPresence?.()
  await Promise.all([
    ...(dialogueEvidence ? [rm(resultPath, { force: true })] : []),
    rm(smokeUserData, { recursive: true, force: true }),
    rm(smokeAdapterData, { recursive: true, force: true }),
    ...(shortCodexHome ? [rm(smokeCodexHome, { recursive: true, force: true })] : []),
  ])
}
