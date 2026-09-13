import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import type { TaskControlService } from "./control/TaskControlService"
import { createDesktopControlFixture } from "../../scripts/fixtures/desktop-control-fixture"

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const assert = (value: unknown, label: string) => { if (!value) throw new Error(`Desktop control smoke: ${label}`) }
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 25000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await wait(60) }
  throw new Error(`Desktop control smoke timed out: ${label}`)
}

export async function runDesktopControlSmoke(o: { bubble: ActivityBubbleWindowController; control: TaskControlService; home: string; evidenceDirectory: string }) {
  assert(o.control.snapshot().autoConnect && o.control.snapshot().source === "desktop", "automatic connection enabled at app startup")
  // The owner starts after Daemonlet. No connect call/path entry should be necessary.
  const desktop = await createDesktopControlFixture({ home: o.home, fragmented: true })
  try {
    await mkdir(o.evidenceDirectory, { recursive: true })
    o.bubble.setView("control", false)
    const win = o.bubble.window!
    const evaluate = (script: string) => win.webContents.executeJavaScript(script)
    const capture = async (name: string) => { await wait(180); await writeFile(join(o.evidenceDirectory, name), (await win.webContents.capturePage()).toPNG()) }
    const click = async (label: string) => {
      await until(async () => await evaluate(`Boolean(document.querySelector('button[aria-label=${JSON.stringify(label)}]:not(:disabled)'))`), label)
      await evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`)
    }
    await until(() => o.control.snapshot().connection === "ready" && o.control.snapshot().threads.length === 2, "automatic desktop discovery")
    await until(async () => await evaluate("Boolean(document.querySelector('#control-thread'))"), "conversation picker")
    await capture("desktop-connected.png")
    const key = o.control.snapshot().threads[0].key
    await evaluate(`(() => { const select = document.querySelector('#control-thread'); select.value = ${JSON.stringify(key)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await until(() => Boolean(o.control.snapshot().threads.find(t => t.key === key)?.canStop), "selected live desktop task")
    const fill = async (text: string) => {
      await evaluate(`(() => { const node = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, ${JSON.stringify(text)}); node.dispatchEvent(new Event('input', { bubbles: true })); })()`)
      await until(async () => await evaluate("[...document.querySelectorAll('button')].some(b => b.textContent.trim().startsWith('전송') && !b.disabled)"), "send enabled")
      await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('전송')).click()")
    }
    await capture("desktop-running.png")
    assert(!o.control.snapshot().threads.find(t => t.key === key)?.canSend, "desktop running steer is restricted")
    assert(await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('전송')).disabled"), "running send button disabled")
    assert(!desktop.calls.some(call => call.method === "thread-follower-steer-turn"), "no unsafe desktop steer")
    await click("선택한 작업 실행 중지")
    await until(() => o.control.snapshot().threads.find(t => t.key === key)?.state === "idle", "desktop stop observed")
    assert(desktop.calls.find(call => call.method === "thread-follower-interrupt-turn")?.params.expectedTurnId === desktop.turns[0], "exact expected turn stop")
    await capture("desktop-stopped.png")
    await fill("같은 데스크톱 대화에 후속 질문")
    await until(() => desktop.calls.some(call => call.method === "thread-follower-start-turn"), "desktop idle follow-up")
    await until(async () => await evaluate("document.querySelector('textarea').value === ''"), "follow-up confirmed")
    const followUp = desktop.calls.find(call => call.method === "thread-follower-start-turn")!
    assert(followUp.params.conversationId === desktop.ids[0] && followUp.params.turnStart.context.inheritThreadSettings === true, "same conversation with inherited settings")
    const connects = desktop.calls.filter(call => call.method === "initialize").length
    desktop.dropConnections()
    await until(() => desktop.calls.filter(call => call.method === "initialize").length > connects && o.control.snapshot().threads.length === 2 && o.control.snapshot().selectedKey === null, "automatic reconnect")
    assert(desktop.calls.filter(call => call.method === "thread-follower-start-turn").length === 1, "reconnect never repeats a send")
    await capture("desktop-reconnected.png")
    await click("Codex 연결 해제")
    await until(() => !o.control.snapshot().autoConnect && o.control.snapshot().connection === "disconnected", "explicit disconnect pauses automatic connection")
    const pausedCount = desktop.calls.filter(call => call.method === "initialize").length
    await wait(1200)
    assert(desktop.calls.filter(call => call.method === "initialize").length === pausedCount, "disconnect remains paused")
    await capture("desktop-paused.png")
    const geometry = await evaluate(`(() => { const panel = document.querySelector('[aria-label="Codex 작업 제어"]'); return { height: innerHeight, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, textareaHeight: document.querySelector('textarea').getBoundingClientRect().height }; })()`)
    assert(geometry.scrollHeight <= geometry.clientHeight + 1 && geometry.textareaHeight >= 40, "automatic connection controls fit")
    const result = { packagedUi: true, syntheticDesktopOwner: true, realDesktopActions: false, defaultAutoConnect: true, automaticDiscovery: true, manualSocketEntryRequired: false, desktopRunningSteerRestricted: true, exactTurnStop: true, sameConversationFollowUp: true, inheritedThreadSettings: true, automaticReconnect: true, reconnectNeverResends: true, explicitDisconnectPauses: true, noHistoricalResume: desktop.calls.every(call => !/resume|load-complete-history/.test(call.method)), geometry }
    await writeFile(join(o.evidenceDirectory, "packaged-desktop-control-smoke.json"), `${JSON.stringify(result, null, 2)}\n`)
    return result
  } catch (error) {
    if (o.bubble.window && !o.bubble.window.isDestroyed()) await writeFile(join(o.evidenceDirectory, "failure.png"), (await o.bubble.window.webContents.capturePage()).toPNG()).catch(() => {})
    throw error
  } finally { o.control.disconnect(); o.bubble.setView("activity", false); await desktop.close() }
}
