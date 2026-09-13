import type { TaskEventSource } from "../behavior/TaskEventSource"
import type { CharacterDialogueController } from "../dialogue/CharacterDialogueController"
import type { DialogueSnapshot } from "../dialogue/types"
import { createDefaultDialogueProfile } from "../dialogue/DefaultDialogueProfile"
import { SpeechBubbleOverlay } from "../pet/SpeechBubbleOverlay"
import { useCallback, useEffect, useRef, useState } from "react"
import { DebugPanel } from "./DebugPanel"
import { FileDropZone } from "./FileDropZone"
import { HitAreaOverlay } from "../debug/HitAreaOverlay"
import { Anime25DRuntime } from "../engine/anime25d/Anime25DRuntime"
import { DEFAULT_PARAMETERS } from "../engine/anime25d/Anime25DParameters"
import type { RigDiagnostics } from "../engine/anime25d/types"
import { QualityComparison } from "./QualityComparison"
import { loadCharacterCatalog } from "../pose/PoseManifest"
import type { LoadedCharacter, PoseSummary } from "../pose/types"
import { CharacterBehaviorController } from "../behavior/CharacterBehaviorController"
import { MockTaskEventSource } from "../behavior/MockTaskEventSource"
import { createDefaultBehaviorProfile } from "../behavior/BehaviorManifest"
import type { CharacterBehaviorDiagnostics, CharacterTaskEvent } from "../behavior/types"
import type { ProtocolDebugApi } from "./ProtocolDebugPanel"
import { CharacterSession } from "../runtime/CharacterSession"
import { labSelectionKey, parseLabSelectionKey, type LabSelection } from "./LabSelection"

const catalogUrl = typeof window !== "undefined" && window.motionLabDesktop ? "pet://app/characters/catalog.json" : "/characters/catalog.json"

declare global {
  interface Window {
    __codexPetDebug?: {
      dispatch(event: CharacterTaskEvent): void
      getSnapshot(): CharacterBehaviorDiagnostics
      getRuntimeDiagnostics(): RigDiagnostics
      getResourceDiagnostics(): ReturnType<Anime25DRuntime["getResourceDiagnostics"]>
      advance(ms: number): CharacterBehaviorDiagnostics
      dialogue?: CharacterDialogueController
      protocol?: ProtocolDebugApi
    }
  }
}

const EMPTY: RigDiagnostics = {
  renderer: "Anime2.5DRig WebGL1", rigger: "Rigger.buildRig", upstreamCommit: "d48825867acd081de22b0e7b5585bb562288796d",
  webglStencil: false, fps: 0, psdCanvas: "—", psdLayerCount: 0, layerNames: [], layerOrder: [], missingRequiredLayers: [],
  rigLayerCount: 0, meshCount: 0, textureCount: 0, headLayers: 0, bodyLayers: 0, eyeLayers: 0, hairLayers: 0, hairStrandCount: 0,
  syntheticEyeClose: false, syntheticMouthClose: false, warnings: [], anchors: null, pointerModel: null,
  hitArea: "background", gesture: "—", interactionState: "IDLE", poseState: "BASE", parameters: DEFAULT_PARAMETERS,
  pose: {
    id: null, label: null, psd: null, loadStatus: "unavailable", registrationStatus: "unavailable", registration: null,
    state: "BASE", progress: 0, mix: 0, activeLayerCount: 0, baseGpuResources: 0, poseGpuResources: 0,
    sharedBaseLayers: [], baseReplaceLayers: [], poseReplaceLayers: [], poseAdditiveLayers: [], availablePoses: [], motionLayerCount: 0, warnings: [], error: null,
  },
  qualityMode: "RIG_ANIMATED", hairTestMode: "combined", autoBlink: true,
  motionSources: [],
  blink: { enabled: true, phase: "IDLE", nextBlinkAt: 0, nextBlinkInMs: 0, currentCycleDurationMs: 0, baselineEyeOpenL: 1, baselineEyeOpenR: 1, forcedBlinkCount: 0 },
  gaze: { mode: "CENTER", pointerActive: false, idle: { enabled: true, active: false, eyeX: 0, eyeY: 0, headX: 0, headY: 0, targetEyeX: 0, targetEyeY: 0, nextTargetAt: 0, nextTargetInMs: 0 }, pointer: { eyeX: 0, eyeY: 0, headX: 0, headY: 0 } },
  lifecycle: [], layerInspections: [], hiddenLayers: [],
  isolatedLayer: null, qualityFindings: [], sourceReferenceUrl: null, characterId: null,
  hairPhysics: {
    frontHair: { amplitude: 0.72, stiffness: 78, damping: 12, wind: 0.34, inertia: 0.62, rootLock: 0.3, maxOffset: 14 },
    backHair: { amplitude: 0.86, stiffness: 48, damping: 9.5, wind: 0.46, inertia: 0.82, rootLock: 0.24, maxOffset: 22 },
    layers: {},
  },
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const selectionRef = useRef<LabSelection>({ kind: "character", id: "gpichan" })
  const loadedManifestRef = useRef<string | null>(null)
  const loadEpochRef = useRef(0)
  const poseActionEpochRef = useRef(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  const characterSessionRef = useRef<CharacterSession | null>(null)
  const [runtime, setRuntime] = useState<Anime25DRuntime | null>(null)
  const [diagnostics, setDiagnostics] = useState<RigDiagnostics>(EMPTY)
  const [overlayVisible, setOverlayVisible] = useState(false)
  const [status, setStatus] = useState("See-through PSD를 열어 실제 자동 리깅을 시작하세요.")
  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<LabSelection>({ kind: "character", id: "gpichan" })
  const [models, setModels] = useState<LoadedCharacter[]>([])
  const [selectedPoseId, setSelectedPoseId] = useState("")
  const [behaviorController, setBehaviorController] = useState<CharacterBehaviorController | null>(null)
  const [dialogueController, setDialogueController] = useState<CharacterDialogueController | null>(null)
  const [dialogueSnapshot, setDialogueSnapshot] = useState<DialogueSnapshot | null>(null)
  const connectSource = useCallback((source: TaskEventSource) => characterSessionRef.current?.connectTaskSource(source), [])
  const [taskSource, setTaskSource] = useState<MockTaskEventSource | null>(null)
  const [behaviorDiagnostics, setBehaviorDiagnostics] = useState<CharacterBehaviorDiagnostics | null>(null)
  const setProtocolDebugApi = useCallback((api: ProtocolDebugApi | null) => {
    if (!import.meta.env.DEV || !window.__codexPetDebug) return
    if (api) window.__codexPetDebug.protocol = api
    else delete window.__codexPetDebug.protocol
  }, [])

  useEffect(() => {
    if (!canvasRef.current) return
    let characterSession: CharacterSession
    try {
      characterSession = new CharacterSession(canvasRef.current, catalogUrl)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
      return
    }
    characterSessionRef.current = characterSession
    const engine = characterSession.runtime
    const behavior = characterSession.behavior
    const mockSource = new MockTaskEventSource()
    characterSession.connectTaskSource(mockSource)
    const loadController = new AbortController()
    const lifetime = new AbortController()
    loadControllerRef.current = loadController
    const loadEpoch = ++loadEpochRef.current
    const unsubscribe = engine.subscribe(() => setDiagnostics(engine.getDiagnostics()))
    const unsubscribeDialogue = characterSession.dialogue.subscribe(() => setDialogueSnapshot(characterSession.dialogue.getSnapshot()))
    const onVisibility = () => characterSession.dialogue.setAvailable(!document.hidden)
    document.addEventListener("visibilitychange", onVisibility)
    onVisibility()
    const unsubscribeBehavior = behavior.subscribe(() => setBehaviorDiagnostics(behavior.getDiagnostics()))
    setDiagnostics(engine.getDiagnostics())
    const resize = () => engine.resize()
    window.addEventListener("resize", resize)
    const onKeyDown = () => behavior.dispatch({ type: "USER_ACTIVITY", source: "keyboard" })
    window.addEventListener("keydown", onKeyDown)
    characterSession.start()
    setRuntime(engine)
    setDialogueController(characterSession.dialogue)
    setDialogueSnapshot(characterSession.dialogue.getSnapshot())
    setBehaviorController(behavior)
    setTaskSource(mockSource)
    setBehaviorDiagnostics(behavior.getDiagnostics())
    if (import.meta.env.DEV) {
      window.__codexPetDebug = {
        dialogue: characterSession.dialogue,
        dispatch: (event) => mockSource.dispatch(event),
        getSnapshot: () => behavior.getDiagnostics(),
        getRuntimeDiagnostics: () => engine.getDiagnostics(),
        getResourceDiagnostics: () => engine.getResourceDiagnostics(),
        advance: (ms) => {
          behavior.advance(ms)
          return behavior.getDiagnostics()
        },
      }
    }

    let catalogGeneration = -1
    let catalogEpoch = 0
    const refreshCatalog = async (generation: number) => {
      if (generation <= catalogGeneration) return
      catalogGeneration = generation
      const request = ++catalogEpoch
      characterSession.invalidateCatalog(generation)
      try {
        const catalog = await loadCharacterCatalog(catalogUrl, lifetime.signal)
        if (lifetime.signal.aborted || request !== catalogEpoch) return
        setModels(catalog.characters)
        const current = selectionRef.current
        if (current.kind === "loose-psd") return
        const selected = catalog.characters.find(c => c.id === current.id) ?? catalog.characters.find(c => c.id === "gpichan") ?? catalog.characters[0]
        if (!selected) throw new Error("Character catalog is empty")
        if (loadedManifestRef.current === selected.manifestUrl) return
        selectionRef.current = { kind: "character", id: selected.id }
        setSelection(selectionRef.current); setSelectedPoseId("")
        await characterSession.loadCharacter(selected.id, lifetime.signal)
        if (lifetime.signal.aborted || request !== catalogEpoch) return
        loadedManifestRef.current = selected.manifestUrl
        const d = engine.getDiagnostics()
        setStatus(`${selected.label} · ${d.rigLayerCount} rig layers · ${d.pose.availablePoses.length} poses`)
      } catch (error) {
        if (!lifetime.signal.aborted && request === catalogEpoch) setStatus(error instanceof Error ? `로드 실패: ${error.message}` : "모델 로드에 실패했습니다.")
      }
    }
    const registry = window.motionLabDesktop?.characters
    const unsubscribeCharacters = registry?.onChanged(value => { void refreshCatalog(value.generation) })
    if (registry) void registry.list().then(value => refreshCatalog(value.generation)).catch(() => setStatus("캐릭터 목록을 읽지 못했습니다."))
    else void refreshCatalog(0)

    return () => {
      lifetime.abort()
      loadController.abort()
      unsubscribeCharacters?.()
      loadEpochRef.current++
      unsubscribe()
      unsubscribeBehavior()
      unsubscribeDialogue()
      mockSource.dispose()
      document.removeEventListener("visibilitychange", onVisibility)
      characterSession.dispose()
      characterSessionRef.current = null
      window.removeEventListener("resize", resize)
      window.removeEventListener("keydown", onKeyDown)
      delete window.__codexPetDebug
    }
  }, [])

  const load = async (file: File) => {
    if (!runtime) return
    loadControllerRef.current?.abort()
    const loadEpoch = ++loadEpochRef.current
    setLoading(true)
    setStatus(`${file.name} 분석 중…`)
    dialogueController?.configure(createDefaultDialogueProfile(), null)
    behaviorController?.prepareForModelChange()
    try {
      const result = await runtime.loadPsd(file)
      if (loadEpoch !== loadEpochRef.current) return
      behaviorController?.configure(createDefaultBehaviorProfile(), [], false)
      selectionRef.current = { kind: "loose-psd" }
      loadedManifestRef.current = null
      setSelection(selectionRef.current)
      setSelectedPoseId("")
      setStatus(`${file.name} · ${result.model.rig.layers.length} rig layers · ${result.model.rig.layers.reduce((sum, layer) => sum + (layer.strands?.length ?? 0), 0)} hair strands`)
    } catch (error) {
      if (loadEpoch !== loadEpochRef.current) return
      setStatus(error instanceof Error ? `로드 실패: ${error.message}` : "PSD 로드에 실패했습니다.")
    } finally {
      if (loadEpoch === loadEpochRef.current) setLoading(false)
    }
  }

  const selectModel = async (value: string) => {
    const nextSelection = parseLabSelectionKey(value)
    if (!nextSelection) return
    selectionRef.current = nextSelection
    setSelection(nextSelection)
    setSelectedPoseId("")
    loadControllerRef.current?.abort()
    const loadController = new AbortController()
    loadControllerRef.current = loadController
    const loadEpoch = ++loadEpochRef.current
    if (!runtime || nextSelection.kind === "loose-psd") {
      if (nextSelection.kind === "loose-psd") setStatus("외부 See-through PSD를 드롭하거나 파일 선택으로 여세요.")
      setLoading(false)
      return
    }
    const model = models.find((candidate) => candidate.id === nextSelection.id)
    if (!model) return
    setLoading(true)
    setStatus(`${model.label} 로드 중…`)
    try {
      await characterSessionRef.current?.loadCharacter(model.id, loadController.signal)
      if (loadController.signal.aborted || loadEpoch !== loadEpochRef.current) return
      loadedManifestRef.current = model.manifestUrl
      const loadedDiagnostics = runtime.getDiagnostics()
      const pose = loadedDiagnostics.pose.availablePoses.length ? ` · ${loadedDiagnostics.pose.availablePoses.length} poses available` : " · no pose asset"
      setStatus(`${model.label} · ${loadedDiagnostics.rigLayerCount} rig layers · ${loadedDiagnostics.qualityFindings.length} findings${pose}`)
    } catch (error) {
      if (loadController.signal.aborted || loadEpoch !== loadEpochRef.current) return
      console.error(error)
      setStatus(error instanceof Error ? `로드 실패: ${error.message}` : "모델 로드에 실패했습니다.")
    } finally {
      if (loadEpoch === loadEpochRef.current) setLoading(false)
    }
  }

  const capture = () => {
    const comparison = document.querySelector<HTMLCanvasElement>(".quality-comparison-canvas")
    let target = comparison
    if (!target && runtime) {
      const frame = runtime.captureCurrentFrame()
      target = document.createElement("canvas")
      target.width = frame.width
      target.height = frame.height
      target.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0)
    }
    if (!target) return
    target.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${diagnostics.characterId ?? "external"}-${diagnostics.qualityMode.toLowerCase()}.png`
      link.click()
      URL.revokeObjectURL(url)
    }, "image/png")
  }

  const size = diagnostics.anchors ? {
    width: Number(diagnostics.psdCanvas.split(" × ")[0]),
    height: Number(diagnostics.psdCanvas.split(" × ")[1]),
  } : { width: 1, height: 1 }

  const runPoseAction = async (action: "load" | "enter" | "toggle") => {
    if (!runtime) return
    const epoch = ++poseActionEpochRef.current, modelEpoch = loadEpochRef.current
    if (!selectedPoseId) {
      runtime.disposePose()
      setStatus("Base pose active")
      return
    }
    try {
      const summary = runtime.listPoses().find((pose) => pose.id === selectedPoseId)
      if (action === "load") {
        if (runtime.getActivePoseId()) await runtime.transitionToPose(selectedPoseId, { waitUntil: "STARTED" })
        else await runtime.loadPoseById(selectedPoseId)
      }
      if (action === "enter") await runtime.enterPose(selectedPoseId)
      if (action === "toggle") await runtime.togglePose(selectedPoseId)
      if (epoch === poseActionEpochRef.current && modelEpoch === loadEpochRef.current) setStatus(`${summary?.label ?? selectedPoseId} · ${action === "load" ? "loaded" : action === "enter" ? "entering" : "toggled"}`)
    } catch (error) {
      if (epoch === poseActionEpochRef.current && modelEpoch === loadEpochRef.current) setStatus(error instanceof Error ? `Pose ${action} 실패: ${error.message}` : `Pose ${action} 실패`)
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">A2.5</span><div><h1>Motion Lab</h1><p>See-through PSD → Anime2.5DRig → WebGL1</p></div></div>
        <div className="engine-badge"><span className={diagnostics.rigLayerCount ? "status-dot live" : "status-dot"} />{diagnostics.rigLayerCount ? "RIG ONLINE" : "AWAITING PSD"}</div>
      </header>

      <section className="workspace">
        <div className="stage-column">
          <div className="stage-toolbar">
            <FileDropZone onFile={load} disabled={!runtime || loading} />
            <div className="stage-stats"><span>{diagnostics.rigLayerCount || 0} meshes</span><span>{diagnostics.hairStrandCount || 0} strands</span><span>{diagnostics.fps || 0} fps</span></div>
          </div>
          <div className="stage" data-testid="rig-stage" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void load(event.dataTransfer.files[0]) }}>
            <div className="stage-grid" />
            <canvas ref={canvasRef} aria-label="Anime2.5DRig WebGL canvas" />
            {runtime && <QualityComparison mode={diagnostics.qualityMode} image={diagnostics.qualityMode === "RAW_PSD_COMPOSITE" || diagnostics.qualityMode === "CLEANED_PSD_COMPOSITE" ? runtime.getComposite(diagnostics.qualityMode) : null} sourceUrl={diagnostics.sourceReferenceUrl} />}
            {runtime && dialogueSnapshot && <SpeechBubbleOverlay snapshot={dialogueSnapshot} runtime={runtime} canvasRef={canvasRef} />}
            {runtime && <HitAreaOverlay resolver={runtime.getHitAreaResolver()} width={size.width} height={size.height} visible={overlayVisible} />}
            {!diagnostics.rigLayerCount && <div className="empty-stage"><span className="empty-icon">PSD</span><h2>Layered character required</h2><p>flat PNG와 CSS clip은 사용하지 않습니다.<br />ComfyUI-See-through가 만든 PSD를 드롭하세요.</p></div>}
            <div className="stage-caption">{status}</div>
          </div>
          <div className="interaction-hints"><span>Move <b>gaze + head follow</b></span><span>Tap <b>recoil</b></span><span>Hold <b>face focus</b></span><span>Drag head <b>petting</b></span></div>
        </div>
        {runtime && behaviorController && behaviorDiagnostics && taskSource ? <DebugPanel diagnostics={diagnostics} runtime={runtime} behavior={behaviorController} behaviorDiagnostics={behaviorDiagnostics} taskSource={taskSource} dialogue={dialogueController ?? undefined} onSourceChange={connectSource} onProtocolApiChange={setProtocolDebugApi} overlayVisible={overlayVisible} onToggleOverlay={() => setOverlayVisible((value) => !value)} models={[...models.map(({ id, label }) => ({ id: labSelectionKey({ kind: "character", id }), label })), { id: labSelectionKey({ kind: "loose-psd" }), label: "External PSD" }]} selectedModel={labSelectionKey(selection)} onSelectModel={(value) => void selectModel(value)} onCapture={capture} poses={diagnostics.pose.availablePoses as PoseSummary[]} selectedPoseId={selectedPoseId} onSelectPose={setSelectedPoseId} onLoadPose={() => void runPoseAction("load")} onEnterPose={() => void runPoseAction("enter")} onTogglePose={() => void runPoseAction("toggle")} /> : <aside className="debug-panel"><div className="warning">WebGL 초기화 실패</div></aside>}
      </section>
    </main>
  )
}
