import { app, BrowserWindow } from "electron"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { resolve, join } from "node:path"
import os from "node:os"
import { verifyMotion, soakMotion } from "./motion-qa-cases"

app.commandLine.appendSwitch("js-flags", "--expose-gc")
app.setPath("userData", process.env.MOTION_QA_USER_DATA!)
app.on("window-all-closed", () => {})
await app.whenReady()
const stage = process.env.MOTION_QA_STAGE ?? "after"
if (!["before", "after"].includes(stage)) throw new Error("MOTION_QA_STAGE must be before or after")
const evidence = resolve(process.env.MOTION_QA_EVIDENCE_DIR ?? "docs/evidence/desktop-motion-quality")
await mkdir(join(evidence, stage), { recursive: true })
const makeWindow = () => new BrowserWindow({ width: 460, height: 460, useContentSize: true, show: true, title: "Daemonlet · isolated motion QA", webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
let window!: BrowserWindow
const run = (script: string) => window.webContents.executeJavaScript(script, true)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(expression: string, label: string) { for (let i=0; i<300; i++) { if (await run(expression)) return; await wait(50) } throw new Error(`Timeout: ${label}`) }
async function fresh() { if (window && !window.isDestroyed()) window.destroy(); window = makeWindow(); await window.loadURL(process.env.MOTION_QA_URL!); await until("window.motionQaReady", "QA ready"); await wait(500) }
async function capture(name: string, duration: number, start: string, events: Array<[number, string]> = []) {
  if (process.env.MOTION_QA_SCENARIOS && !process.env.MOTION_QA_SCENARIOS.split(",").includes(name)) return
  await fresh()
  await run(`motionQa.begin(${JSON.stringify(name)})`)
  if (start) await run(start)
  let elapsed = 0
  for (const [at, script] of events) { await wait(Math.max(0, at-elapsed)); await run(script); elapsed=at }
  await wait(Math.max(0,duration-elapsed))
  const result = await run("motionQa.finish()")
  if (result.video) await writeFile(join(evidence, stage, `${name}.webm`), Buffer.from(result.video,"base64"))
  delete result.video
  if (result.still) await writeFile(join(evidence, stage, `${name}.png`), Buffer.from(result.still, "base64"))
  delete result.still
  await writeFile(join(evidence, stage, `${name}.json`), JSON.stringify(result, null, 2)+"\n")
  process.stdout.write(`${stage} ${name}: ${result.frameTime.count} frames, errors ${result.errors.length}\n`)
  if (result.errors.length || !result.frameTime.count) throw new Error(`Capture failed: ${name}`)
}
async function capturePerformance() {
  await fresh()
  await wait(2000)
  // Electron's first CPU sample is zero because it has no previous measurement.
  app.getAppMetrics()
  await run("motionQa.begin('performance-idle', false)")
  const cpuSamples: unknown[] = []
  for (let i = 0; i < 5; i++) {
    await wait(3000)
    cpuSamples.push(app.getAppMetrics().map(({type,cpu,memory})=>({type,cpu,memory})))
  }
  const performance = await run("motionQa.finish()")
  delete performance.video
  delete performance.still
  performance.cpuSamples = cpuSamples
  performance.cpuMethod = "getAppMetrics prewarmed; five consecutive 3-second samples; Electron-reported percentCPUUsage per process"
  performance.logicalCpus = os.cpus().length
  await writeFile(join(evidence, stage, "performance.json"),JSON.stringify(performance,null,2)+"\n")
  if (performance.errors.length || !performance.frameTime.count) throw new Error("Performance capture failed")
}
try {
  const mode=process.env.MOTION_QA_MODE ?? "media"
  if (!["media", "performance", "inspect", "verify", "soak"].includes(mode)) throw new Error(`Unknown QA mode: ${mode}`)
  if(mode === "inspect") {
    await fresh()
    await run("motionQa.session.behavior.setControlMode('MANUAL_POSE');motionQa.runtime.enterPose('writing',{waitUntil:'STARTED'})")
    await until("motionQa.runtime.getPoseDiagnostics().state==='ACTIVE_LOOP'","inspect active")
    await writeFile(join(evidence,"after","writing-full-frame.png"),Buffer.from(await run("motionQa.runtime.canvas.toDataURL('image/png').split(',')[1]"),"base64"))
  } else if(mode === "verify" || mode === "soak") {
    await fresh()
    const h={run,wait,until,window,evidence}
    if(mode === "verify") await verifyMotion(h)
    else await soakMotion(h,Number(process.env.MOTION_QA_SOAK_MS ?? 1200000))
  } else if (mode === "performance") {
    await capturePerformance()
  } else {
  await capture("idle", 30000, "", [[22000, "motionQa.runtime.setPointerTarget(800, 150)"], [26000, "motionQa.runtime.clearPointerTarget()"]])
  await capture("bored", 24000, "motionQa.session.behavior.simulateIdleThreshold()", [[20000,"motionQa.dispatch('USER_ACTIVITY')"]])
  await capture("writing-cycle", 10000, "motionQa.dispatch('TASK_STARTED')", [[8500,"motionQa.dispatch('TASK_CANCELLED', 'synthetic-A', 'user-interrupted')"]])
  if (!process.env.MOTION_QA_SCENARIOS || process.env.MOTION_QA_SCENARIOS.split(",").includes("writing-cycle")) await writeFile(join(evidence, stage, "writing-geometry.json"), JSON.stringify(await run("motionQa.geometry()"),null,2)+"\n")
  await capture("memo-cycle", 7000, "motionQa.session.behavior.setControlMode('MANUAL_POSE'); motionQa.runtime.enterPose('memo-check', {waitUntil:'STARTED'})", [[5500,"motionQa.runtime.exitPose()"]])
  await capture("outcome-sequence", 12500, "motionQa.dispatch('TASK_STARTED')", [[1500,"motionQa.dispatch('TASK_COMPLETED')"],[5700,"motionQa.dispatch('TASK_STARTED')"],[6900,"motionQa.dispatch('TASK_FAILED')"],[8500,"motionQa.dispatch('TASK_STARTED')"],[9900,"motionQa.dispatch('TASK_CANCELLED', 'synthetic-A', 'user-interrupted')"]])
  await capturePerformance()
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "public/characters", "src", "electron", "package.json", "scripts/motion-qa*"],{encoding:"utf8"}).trim().split("\n")
  const hashes: Record<string,string> = {}
  for (const file of files) hashes[file] = createHash("sha256").update(await readFile(file)).digest("hex")
  const baseline = { commit: execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(), branch: execFileSync("git",["branch","--show-current"],{encoding:"utf8"}).trim(), capturedAt: new Date().toISOString(), os: { platform:os.platform(), release:os.release(), arch:os.arch() }, versions:process.versions, viewport: (await run("motionQa.snapshot()")).viewport, browserWindowDIP:window.getContentBounds(), seed:1103, hashes, capture: "wall-clock MediaRecorder at 30 fps, scaled canvas with timestamp; synthetic input", nativeMouse:"not-tested by this harness" }
  await writeFile(join(evidence, stage === "before" ? "baseline.json" : "candidate.json"),JSON.stringify(baseline,null,2)+"\n")
  }
} finally { if (window && !window.isDestroyed()) window.destroy(); app.quit() }
