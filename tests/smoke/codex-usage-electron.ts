import { app, BrowserWindow, ipcMain } from "electron"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { installAppProtocol, registerAppScheme } from "../../electron/main/AppProtocol"
import { ActivityBubbleWindowController } from "../../electron/main/ActivityBubbleWindowController"
import { BubblePresentationIpcController } from "../../electron/main/BubblePresentationIpcController"
import { CodexUsageIpcController } from "../../electron/main/CodexUsageIpcController"
import { CodexUsageService } from "../../electron/main/codex-usage/CodexUsageService"
import { ActivityStore } from "../../electron/main/activity/ActivityStore"
import { ACTIVITY_IPC } from "../../electron/shared/activity-contract"
import { TASK_CONTROL_IPC } from "../../electron/shared/task-control-contract"
import { defaultDesktopSettings } from "../../electron/shared/desktop-settings"
import { setAppLanguage } from "../../electron/main/AppLanguage"
import type { UsageRead } from "../../electron/main/codex-usage/CodexUsageReader"
const root = process.env.USAGE_SMOKE_ROOT!, output = process.env.USAGE_SMOKE_OUTPUT!
app.setPath("userData", process.env.USAGE_SMOKE_PROFILE!); registerAppScheme()
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const assert = (v: unknown, label: string) => { if (!v) throw Error(label) }
async function main() {
  await app.whenReady(); installAppProtocol(join(root, "dist"))
  const settings = defaultDesktopSettings(), pet = new BrowserWindow({ x: 750, y: 300, width: 300, height: 300, show: false })
  await pet.loadURL("data:text/html,fixture"); pet.showInactive()
  const bubbles = new ActivityBubbleWindowController(join(root, "dist-electron/activity-preload.cjs"))
  bubbles.attach(pet, settings)
  const bubbleIpc = new BubblePresentationIpcController(bubbles); bubbleIpc.register()
  const store = new ActivityStore(); store.accept({ protocolVersion: 1, source: "codex-adapter", sourceInstanceId: "fixture", sessionId: "fixture", messageId: "one", sequence: 1, sentAt: Date.now(), frameType: "event", payload: { type: "run.completed", runId: "A" } })
  const activity = { ...store.view(), revision: 1, storage: "saved" as const, historyRecovered: false, navigation: "none" as const }
  ipcMain.handle("side-chat:get", () => ({ ok: false, code: "UNAVAILABLE" }))
  ipcMain.handle("task-control:get", () => ({ ok: false, code: "UNAVAILABLE" }))
  ipcMain.handle(ACTIVITY_IPC.get, () => ({ ok: true, value: activity }))
  ipcMain.handle(ACTIVITY_IPC.setCollapsed, (_e, value) => ({ ok: true, value: bubbles.setCollapsed(value) }))
  ipcMain.handle(TASK_CONTROL_IPC.getView, () => ({ ok: true, value: bubbles.getView() }))
  ipcMain.handle(TASK_CONTROL_IPC.view, (_e, view, collapsed) => { bubbles.setView(view, collapsed); return { ok: true, value: bubbles.getView() } })
  let now = Date.now(), calls = 0
  const normal = { fiveHour: { windowDurationMins: 300 as const, usedPercent: 24, resetsAtMs: now + 3600000, freshness: "fresh" as const }, weekly: { windowDurationMins: 10080 as const, usedPercent: 61, resetsAtMs: now + 86400000, freshness: "fresh" as const }, ordinaryUsageAllowed: true }
  let result: UsageRead = { value: normal, scope: "synthetic" }
  let gate: Promise<void> | null = null, releaseGate: () => void = () => {}
  const service = new CodexUsageService(async () => { calls++; await gate; return structuredClone(result) }, () => now)
  const usageIpc = new CodexUsageIpcController(service, bubbles); usageIpc.register()
  const off = bubbles.subscribeUsageVisibility(v => service.setVisible(v))
  service.configure(true, { codexHome: "/fixture", executablePath: "/fixture/codex" })
  bubbles.update(activity)
  const epoch = bubbles.presentation.begin()
  await bubbles.presentation.report({ epoch, sequence: 1, phase: "hidden", available: true, anchor: { x0: .3, x1: .7, y0: .02, y1: .3 } })
  bubbles.presentation.anchor = null; bubbles.sync()
  const win = bubbles.window!, wc = win.webContents
  const js = <T = any>(code: string): Promise<T> => wc.executeJavaScript(code)
  const until = async (code: string) => { for (let i = 0; i < 100; i++) { if (await js(code).catch(() => false)) return; await wait(30) }; throw Error("UI condition: " + code) }
  const report: Record<string, unknown> = { status: "FAIL", platform: process.platform, backend: "synthetic", realAccountCalls: 0 }
  const capture = async (name: string) => { await wait(120); await writeFile(join(output, name + ".png"), (await wc.capturePage()).toPNG()) }
  try {
    await until('document.querySelector(".codex-usage")?.textContent.includes("24%")')
    console.log("usage UI ready")
    const original = await js('document.querySelector("main").dataset.activityId')
    assert(win.getBounds().height > 100, "fallback uses measured footer height")
    await capture("normal-ko")
    console.log("usage normal captured")
    for (const language of ["ko", "en"] as const) {
      setAppLanguage(language)
      for (const zoom of [1, 1.25, 1.5, 2]) {
        wc.setZoomFactor(zoom); bubbles.sync(); await wait(200)
        const geometry = await js(`(()=>{const e=document.querySelector('.codex-usage'),r=e.getBoundingClientRect();return {right:r.right,bottom:r.bottom,height:innerHeight,width:innerWidth,overflow:[...e.querySelectorAll('.codex-usage-windows span')].some(s=>s.scrollWidth>s.clientWidth)}})()`)
        assert(geometry.right <= geometry.width && geometry.bottom <= geometry.height && !geometry.overflow, `footer fits ${language} ${zoom}`)
        await capture(`${language}-${zoom}`)
      }
    }
    console.log("usage zoom verified")
    wc.setZoomFactor(1); setAppLanguage("ko"); await wait(100)
    // Existing pointer lock buffers usage as well as task updates.
    await js('window.activityDesktop.setInteractionLocked(true,true)')
    // DOM pointer capture drives the renderer's real hold path.
    const point = await js('(()=>{const r=document.querySelector(".bubble-menu summary").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()')
    wc.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point }); await wait(60)
    const bounds = win.getBounds()
    result = { value: { ...normal, fiveHour: null }, scope: "synthetic" }; now += 16000; await service.refresh(); await wait(80)
    assert(await js('document.querySelector(".codex-usage").textContent.includes("24%")'), "pointer press buffers quota")
    assert(JSON.stringify(win.getBounds()) === JSON.stringify(bounds), "pointer press retains native bounds")
    wc.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point }); await wait(60)
    await js('document.querySelector(".bubble-menu").open=false; document.activeElement?.blur()')
    await until('document.querySelectorAll(".codex-usage-windows span").length === 1 && document.querySelector(".codex-usage-windows").textContent.includes("주간")')
    assert(await js('!document.querySelector(".codex-usage").getAttribute("title").includes("5시간")'), "weekly-only hides missing five-hour window and tooltip")
    await capture("weekly-only")
    for (const language of ["ko", "en"] as const) {
      setAppLanguage(language); await wait(100)
      for (const zoom of [1, 1.25, 1.5, 2]) {
        wc.setZoomFactor(zoom); bubbles.sync(); await wait(200)
        assert(await js('(()=>{const e=document.querySelector(".codex-usage"),r=e.getBoundingClientRect();return e.querySelectorAll(".codex-usage-windows span").length===1 && r.right<=innerWidth && r.bottom<=innerHeight && !/5시간|5h/.test(e.getAttribute("title"))})()'), `weekly-only fits ${language} ${zoom}`)
        await capture(`weekly-only-${language}-${zoom}`)
      }
    }
    wc.setZoomFactor(1); setAppLanguage("ko"); await wait(100)
    result = { value: { ...normal, ordinaryUsageAllowed: false }, scope: "synthetic" }; now += 16000; await service.refresh()
    await until('document.querySelector(".codex-usage").textContent.includes("사용 제한")'); await capture("restricted")
    let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; releaseGate = resolve })
    service.setVisible(false); now += 180000; service.setVisible(true)
    await until('document.querySelector(".codex-usage").textContent.includes("오래된")'); await capture("stale")
    result = { reason: "not-signed-in" }; gate = null; release(); now += 16000; await service.refresh()
    await until('document.querySelector(".codex-usage").textContent.includes("로그인 필요")'); await capture("signed-out")
    assert(await js('document.querySelector("main").dataset.activityId') === original, "usage preserves selected task")
    bubbles.setCollapsed(true); wc.send(TASK_CONTROL_IPC.viewChanged, bubbles.getView()); await until('Boolean(document.querySelector(".mini-task-chip"))')
    assert(win.getBounds().width === 64, "compact width unchanged"); await capture("collapsed")
    bubbles.setView("control", false); await wait(60); const before = calls; now += 60000; await service.refresh(); assert(calls === before, "control pauses reads")
    bubbles.setView("activity", false); bubbles.setLocalChatVisible(true); await wait(60); assert(!win.isVisible(), "local chat hides activity")
    report.status = "PASS"; report.fixtureReads = calls; report.checks = ["normal", "weekly-only", "restricted", "stale", "signed-out", "ko/en normal and weekly-only zoom 100/125/150/200", "fallback measured height", "input lock", "collapsed", "control pause", "local chat hiding", "task selection preserved"]
  } catch (error) { report.error = String(error); console.error(report.error) }
  finally { releaseGate(); off(); usageIpc.dispose(); bubbleIpc.dispose(); await service.dispose(); bubbles.destroy(); pet.destroy(); await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2)); app.exit(report.status === "PASS" ? 0 : 1) }
}
void main().catch(async error => { await writeFile(join(output, "result.json"), JSON.stringify({ status: "FAIL", error: String(error) })); app.exit(1) })
