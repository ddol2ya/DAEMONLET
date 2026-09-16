import { useT } from "../i18n/useLanguage"
import { useEffect, useRef, useState } from "react"
import type { DesktopSettingsV1 } from "../../electron/shared/desktop-settings"
import type { AdapterStatus } from "../../electron/shared/ipc-contract"
import { CharacterEventProtocolClient } from "../protocol/CharacterEventProtocolClient"
import { ProtocolTaskEventSource } from "../protocol/ProtocolTaskEventSource"
import { CharacterSession } from "../runtime/CharacterSession"
import { ModifierDragController } from "./ModifierDragController"
import { AlphaHitTestController } from "./AlphaHitTestController"
import { ElectronIpcProtocolTransport } from "./ElectronIpcProtocolTransport"
import { LayoutOverlay } from "./LayoutOverlay"
import { PetCanvas } from "./PetCanvas"
import { SpeechBubbleOverlay } from "./SpeechBubbleOverlay"
import type { DialogueSnapshot } from "../dialogue/types"
import type { CharacterSnapshot } from "../../electron/shared/character-pack-contract"

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

export default function PetApp() {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<CharacterSession | null>(null)
  const alphaRef = useRef<AlphaHitTestController | null>(null)
  const [settings, setSettings] = useState<DesktopSettingsV1 | null>(null)
  const [layout, setLayout] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [presentation, setPresentation] = useState({ available: false, epoch: 0 })
  const [dialogue, setDialogue] = useState<DialogueSnapshot | null>(null)
  const [adapter, setAdapter] = useState<AdapterStatus>({ state: "STARTING", message: null, restartCount: 0 })

  useEffect(() => {
    const desktop = window.petDesktop
    const canvas = canvasRef.current
    if (!desktop || !canvas) { setError("Secure desktop bridge is unavailable"); return }
    let disposed = false
    let loadKey: string | null = null
    let successfulKey: string | null = null
    let loadEpoch = 0
    let currentSettings: DesktopSettingsV1 | null = null
    let characters: CharacterSnapshot | null = null
    let visible = false
    let inLayout = false
    let dragging = false
    let loadFailed = false
    let loadingCharacter = false
    const session = new CharacterSession(canvas, "pet://app/characters/catalog.json")
    sessionRef.current = session
    // A native reload may abort fetch before React unmount cleanup runs. Retire
    // the old renderer immediately so cancellation cannot report a load error
    // or a late ready signal for the new renderer/character.
    const unloading = () => { disposed = true; loadEpoch++; session.dialogue.setAvailable(false) }
    window.addEventListener("beforeunload", unloading)
    const updateAvailability = () => {
      if (disposed) { session.dialogue.setAvailable(false); return }
      const available = visible && !inLayout && !dragging && !loadFailed && !loadingCharacter && Boolean(successfulKey) && !document.hidden
      session.dialogue.setAvailable(available)
      setPresentation(old => old.available === available && old.epoch === loadEpoch ? old : { available, epoch: loadEpoch })
    }
    updateAvailability()
    const unsubscribeDialogue = session.dialogue.subscribe(() => setDialogue(session.dialogue.getSnapshot()))
    document.addEventListener("visibilitychange", updateAvailability)
    const transport = new ElectronIpcProtocolTransport(desktop.protocol)
    const client = new CharacterEventProtocolClient(transport, { clientId: "anime25d-desktop-pet" })
    const source = new ProtocolTaskEventSource(client)
    session.connectTaskSource(source)
    session.start()
    const alpha = new AlphaHitTestController(canvas, session.runtime, desktop)
    alphaRef.current = alpha
    const drag = new ModifierDragController(canvas, {
      platform: desktop.platform, allowed: () => !disposed && !inLayout && !loadingCharacter && !loadFailed && Boolean(successfulKey),
      hit: (x, y) => session.runtime.sampleRenderedAlpha(x, y, { radius: 3, threshold: 0.1 }).alpha >= 0.1,
      request: value => desktop.dragWindow(value),
      lock: (active, point) => { if (disposed) return; dragging = active; canvas.style.cursor = active ? "grabbing" : ""; session.setInteractionEnabled(!active && !inLayout && !loadingCharacter && !loadFailed); alpha.setExternalDrag(active, point); updateAvailability() },
    })
    const unsubscribeDrag = desktop.onDragCancelled(drag.cancel)
    const load = async (next: DesktopSettingsV1) => {
      if (disposed) return
      currentSettings = next
      setSettings(next)
      visible = next.visible
      session.dialogue.setEnabled(next.speechBubblesEnabled)
      updateAvailability()
      if (!characters) return
      const entry = characters.entries.find(e => e.id === next.characterId && e.status === "ready")
      if (!entry) return
      const key = `${entry.id}/${entry.revision}`
      if (loadKey === key) return
      const epoch = ++loadEpoch
      loadKey = key
      drag.cancel()
      loadingCharacter = true
      setLoading(true)
      loadFailed = false
      updateAvailability()
      setError(null)
      try {
        await desktop.setMousePassthrough(false)
        if (disposed || epoch !== loadEpoch) return
        await session.loadCharacter(next.characterId)
        if (disposed || epoch !== loadEpoch) return
        await nextFrame()
        if (disposed || epoch !== loadEpoch) return
        successfulKey = key
        loadingCharacter = false
        session.setInteractionEnabled(!inLayout && !dragging)
        setLoading(false)
        updateAvailability()
        alpha.reset()
        desktop.reportReady({ webgl: true, characterId: entry.id, revision: entry.revision, firstFrameAt: performance.now() })
      } catch (reason) {
        if (disposed || epoch !== loadEpoch || reason instanceof DOMException && reason.name === "AbortError") return
        const message = reason instanceof Error ? reason.message : String(reason)
        loadingCharacter = false
        setLoading(false)
        loadFailed = !successfulKey
        session.setInteractionEnabled(!inLayout && !dragging && !loadFailed)
        loadKey = null
        updateAvailability()
        if (!successfulKey) setError(message)
        desktop.reportCharacterLoadFailure({ id: entry.id, revision: entry.revision })
        desktop.reportAlphaFailure(`Character load failed: ${message}`)
      }
    }
    const receiveCharacters = (snapshot: CharacterSnapshot) => {
      if (disposed || characters && snapshot.generation < characters.generation) return
      characters = snapshot
      session.invalidateCatalog(snapshot.generation)
      if (currentSettings) void load(currentSettings)
    }
    const unsubscribeCharacters = desktop.characters.onChanged(receiveCharacters)
    const unsubscribeSettings = desktop.onSettingsChanged((next) => { void load(next) })
    const unsubscribeLayout = desktop.onLayoutChanged((enabled) => {
      drag.cancel()
      setLayout(enabled)
      inLayout = enabled
      updateAvailability()
      session.setInteractionEnabled(!enabled)
      alpha.setLayoutMode(enabled)
    })
    const unsubscribePointerOutside = desktop.onPointerOutside(() => session.runtime.clearPointerTarget())
    const onAdapterStatus = (status: AdapterStatus) => {
      setAdapter(status)
      source.setSourceAvailable(status.codexAvailable ?? true)
      if (status.state === "READY" || status.state === "EXTERNAL_RUNNING") {
        void client.connect().catch(() => { /* CharacterEventProtocolClient performs bounded background reconnects. */ })
      }
    }
    const unsubscribeAdapter = desktop.onAdapterStatus(onAdapterStatus)
    void Promise.all([desktop.characters.list().then(receiveCharacters), desktop.getSettings().then(value => { if (!currentSettings) return load(value) })]).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
    const resize = () => session.runtime.resize()
    window.addEventListener("resize", resize)
    return () => {
      disposed = true
      unsubscribeSettings()
      unsubscribeCharacters()
      unsubscribeLayout()
      unsubscribePointerOutside()
      unsubscribeAdapter()
      unsubscribeDialogue()
      document.removeEventListener("visibilitychange", updateAvailability)
      window.removeEventListener("beforeunload", unloading)
      window.removeEventListener("resize", resize)
      unsubscribeDrag()
      drag.dispose()
      alpha.dispose()
      source.dispose()
      client.dispose()
      session.dispose()
      alphaRef.current = null
      sessionRef.current = null
    }
  }, [])

  const done = () => { void window.petDesktop?.setLayoutMode(false) }
  const setScale = (scale: number) => { void window.petDesktop?.updateSettings({ scale }) }

  return <main className={`pet-root${error ? " has-error" : ""}`}>
    <PetCanvas ref={canvasRef} />
    {loading && !error && <div className="pet-loading" role="status"><span aria-hidden="true" />{t("캐릭터 준비 중…")}</div>}
    {dialogue && sessionRef.current && <SpeechBubbleOverlay snapshot={dialogue} runtime={sessionRef.current.runtime} canvasRef={canvasRef} available={presentation.available} characterEpoch={presentation.epoch} controller={sessionRef.current.dialogue} />}
    {layout && settings && <LayoutOverlay settings={settings} onScale={setScale} onDone={done} />}
    {error && <div className="pet-error" role="alert"><b>Character unavailable</b><span>{error}</span><button onClick={() => void window.petDesktop?.reloadPet()}>Reload Pet</button></div>}
    <div className="sr-only" aria-live="polite">Codex adapter {adapter.state}</div>
  </main>
}
