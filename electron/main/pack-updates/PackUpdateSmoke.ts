import { createReadStream } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { BrowserWindow } from "electron"
import { parseUpdateFeed, type PackUpdateFeed, type PackUpdateState } from "../../shared/pack-update-contract"
import { HuggingFacePackProvider, type HfResponse } from "./HuggingFacePackProvider"
import type { PackUpdateService } from "./PackUpdateService"
import type { SettingsWindowController } from "../SettingsWindowController"
import type { CharacterRegistry } from "../CharacterRegistry"
import type { SideChatService } from "../side-chat/SideChatService"
import type { CharacterSelection } from "../../shared/character-pack-contract"

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
type Plan = { output: string; entries: { seed: string; pack: string; manifestPath: string; feed: PackUpdateFeed }[] }
async function plan(path: string): Promise<Plan> {
  if (process.env.ELECTRON_SMOKE_TEST !== "1" || !process.env.ELECTRON_SMOKE_USER_DATA) throw Error("Isolated pack-update QA required")
  const p = JSON.parse(await readFile(path, "utf8")) as Plan
  for (const e of p.entries) e.feed = parseUpdateFeed(Buffer.from(JSON.stringify(e.feed)))
  return p
}
/** Build-time QA dependency only; production has no local-feed or HTTP override. */
export function createPackUpdateSmokeProvider(path: string) {
  return new HuggingFacePackProvider(async (url, signal): Promise<HfResponse> => {
    const p = await plan(path)
    for (const e of p.entries) {
      if (url.pathname.endsWith(`/resolve/main/${e.manifestPath}`)) return { status: 200, headers: { etag: '"qa-fixed"' }, close() {}, body: (async function* () { yield Buffer.from(JSON.stringify(e.feed)) })() }
      if (url.pathname.endsWith(`/resolve/${e.feed.artifact.revision}/${e.feed.artifact.path}`)) {
        const stream = createReadStream(e.pack, { highWaterMark: 1024 * 1024, signal })
        return { status: 200, headers: { "content-length": String(e.feed.artifact.bytes) }, close() { stream.destroy() }, body: (async function* () { for await (const chunk of stream) { await wait(8); yield chunk } })() }
      }
    }
    return { status: 404, headers: {}, close() {}, body: (async function* () {})() }
  })
}
export async function runPackUpdateSmoke(o: { path: string; registry: CharacterRegistry; service: PackUpdateService; settings: SettingsWindowController; pet: BrowserWindow; sideChat: SideChatService; select: (selection: CharacterSelection) => Promise<void>; selected: () => string }) {
  const p = await plan(o.path); await mkdir(p.output, { recursive: true })
  const rows = []
  for (const e of p.entries) { const preview = await o.registry.prepareImport(e.seed, "pack-update-seed"); await o.registry.commitImport(preview.token, "pack-update-seed") }
  const settings = o.settings.open()
  for (let n = 0; n < 200 && !o.settings.currentOwner(); n++) await wait(50)
  const invoke = (action: unknown) => settings.webContents.executeJavaScript(`window.settingsDesktop.packUpdates.act(${JSON.stringify(action)})`)
  const states = (): Promise<PackUpdateState[]> => settings.webContents.executeJavaScript("window.settingsDesktop.packUpdates.list()")
  const state = async (id: string) => (await states()).find(s => s.packId === id)!
  await settings.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => /캐릭터·표시|Character.*Display/.test(b.textContent))?.click()`)
  o.sideChat.configure(true, "ko")
  const recovered = async (id: string, revision: string) => {
    for (let n = 0; n < 600; n++) {
      if (o.selected() === id && o.registry.get(id)?.revision === revision && !o.sideChat.snapshot().applying && o.registry.readyForUpdate()) return
      await wait(100)
    }
    throw Error("Pack update QA: failed transition retained a recovery lock")
  }
  // Inject a real fetch cancellation into the current renderer load. This is
  // failure-path QA, never evidence of production network/UI success.
  const injectFailure = (id: string, preservedRevision?: string) => o.pet.webContents.executeJavaScript(`(() => {
    const original = globalThis.fetch;
    globalThis.__restorePackFetch = () => { globalThis.fetch = original; delete globalThis.__restorePackFetch };
    globalThis.fetch = (input, options) => {
      const url = String(input?.url ?? input);
      if (url.includes('/character-packs/' + ${JSON.stringify(id)} + '/') && url.endsWith('.psd') && !url.includes(${JSON.stringify(preservedRevision ?? "no-preserved-revision")})) return Promise.reject(new DOMException('Injected pack cancellation', 'AbortError'));
      return original(input, options);
    };
  })()`)
  const restoreFetch = () => o.pet.webContents.executeJavaScript("globalThis.__restorePackFetch?.()")
  const initial = o.registry.get(o.selected())!, failedTarget = p.entries[0].feed.packId
  await injectFailure(failedTarget)
  try {
    const result = await o.select(o.registry.get(failedTarget)!).then(() => "unexpected-ready", error => String(error))
    if (!result.includes("PACK_LOAD")) throw Error("Pack update QA: current AbortError was not reported as failure")
  } finally { await restoreFetch() }
  await recovered(initial.id, initial.revision)
  for (const e of p.entries) {
    const id = e.feed.packId, before = o.registry.get(id)!, other = o.registry.snapshot().entries.filter(x => x.id !== id).map(x => [x.id, x.revision])
    await o.select(before)
    for (let n = 0; n < 200 && o.sideChat.snapshot().applying; n++) await wait(50)
    o.sideChat.setDraft("QA draft stays here; never sent")
    await invoke({ action: "check", packId: id })
    if ((await state(id)).phase !== "available") throw Error("Pack update QA: no candidate")
    const cancelled = invoke({ action: "download", packId: id })
    for (let n = 0; n < 100 && (await state(id)).phase !== "downloading"; n++) await wait(20)
    if (o.service.readyForUpdate()) throw Error("Pack update QA: app shutdown gate missed download")
    await invoke({ action: "cancel", packId: id }); await cancelled
    if (o.registry.get(id)?.revision !== before.revision) throw Error("Pack update QA: cancel mutated registry")
    await invoke({ action: "download", packId: id })
    let candidate = await state(id)
    if (candidate.phase !== "ready" || !candidate.candidateId) throw Error("Pack update QA: not validated")
    if (e === p.entries[0]) {
      await injectFailure(id, before.revision)
      try {
        const result = await invoke({ action: "apply", candidateId: candidate.candidateId }).then(() => "unexpected-ready", error => String(error))
        if (!result.includes("PACK_LOAD")) throw Error("Pack update QA: active update failure was not reported")
      } finally { await restoreFetch() }
      await recovered(id, before.revision)
      if (o.sideChat.snapshot().draft !== "QA draft stays here; never sent") throw Error("Pack update QA: recovery lost the draft")
      await invoke({ action: "check", packId: id }); await invoke({ action: "download", packId: id })
      candidate = await state(id)
      if (candidate.phase !== "ready" || !candidate.candidateId) throw Error("Pack update QA: retry blocked after failure")
    }
    await wait(150)
    await writeFile(join(p.output, `${id}-ready.png`), (await settings.webContents.capturePage()).toPNG())
    await invoke({ action: "apply", candidateId: candidate.candidateId })
    if ((await state(id)).phase !== "applied" || o.selected() !== id || o.registry.get(id)?.version !== e.feed.version) throw Error("Pack update QA: apply failed")
    if (JSON.stringify(other) !== JSON.stringify(o.registry.snapshot().entries.filter(x => x.id !== id).map(x => [x.id, x.revision]))) throw Error("Pack update QA: other appearance changed")
    for (let n = 0; n < 200 && o.sideChat.snapshot().applying; n++) await wait(50)
    if (o.sideChat.snapshot().draft !== "QA draft stays here; never sent") throw Error("Pack update QA: draft changed")
    await wait(250); await writeFile(join(p.output, `${id}-applied.png`), (await o.pet.webContents.capturePage()).toPNG())
    await o.registry.rollback(o.registry.get(id)!)
    await o.select(o.registry.get(id)!)
    if (o.registry.get(id)?.revision !== before.revision) throw Error("Pack update QA: restore failed")
    rows.push({ id, before: before.version, candidate: e.feed.version, cancel: "PASS", applyThroughPreload: "PASS", rendererReady: "PASS", draftPreserved: "PASS", otherAppearancesUnchanged: "PASS", rollback: "PASS", appUpdateDownloadGate: "PASS" })
  }
  o.sideChat.configure(false, "ko")
  const result = { status: "PASS", network: "PRIVATE_QA_TRANSPORT", currentAbortFailureRecovery: "PASS", activeUpdateFailureRollbackAndRetry: "PASS", rows, productionCandidate: false, os: process.platform, arch: process.arch }
  await writeFile(join(p.output, "result.json"), JSON.stringify(result, null, 2) + "\n")
  return result
}
