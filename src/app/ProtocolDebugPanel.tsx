import type { TaskEventSource } from "../behavior/TaskEventSource"
import { useEffect, useRef, useState } from "react"
import type { CharacterBehaviorController } from "../behavior/CharacterBehaviorController"
import type { MockTaskEventSource } from "../behavior/MockTaskEventSource"
import { CharacterEventProtocolClient } from "../protocol/CharacterEventProtocolClient"
import { ProtocolLoopbackSource } from "../protocol/ProtocolLoopbackSource"
import { ProtocolTaskEventSource } from "../protocol/ProtocolTaskEventSource"
import type { ProtocolDiagnostics, ProtocolFrame, ProtocolTraceExport } from "../protocol/types"
import { InMemoryProtocolTransport } from "../protocol/transports/InMemoryProtocolTransport"
import { ReplayProtocolTransport } from "../protocol/transports/ReplayProtocolTransport"
import { WebSocketProtocolTransport } from "../protocol/transports/WebSocketProtocolTransport"
import type { CharacterEventTransport } from "../protocol/transports/CharacterEventTransport"
import { ElectronIpcProtocolTransport } from "../pet/ElectronIpcProtocolTransport"

type SourceMode = "DIRECT_MOCK" | "PROTOCOL_LOOPBACK" | "PROTOCOL_WEBSOCKET" | "PROTOCOL_REPLAY" | "CODEX_ADAPTER"
type ProtocolRuntime = {
  client: CharacterEventProtocolClient
  source: ProtocolTaskEventSource
  transport: CharacterEventTransport
  loopback?: ProtocolLoopbackSource
}

export type ProtocolDebugApi = {
  connect(): Promise<void>
  disconnect(reason?: string): void
  inject(frame: string | ProtocolFrame | unknown): void
  requestSnapshot(): void
  getDiagnostics(): ProtocolDiagnostics
  exportTrace(): ProtocolTraceExport
}

const EMPTY_DIAGNOSTICS: ProtocolDiagnostics = {
  connectionState: "DISCONNECTED", connectionEpoch: 0, endpoint: null, protocolVersion: null, source: null, sourceInstanceId: null, sessionId: null,
  lastAppliedSequence: 0, bufferedFrameCount: 0, acceptedCount: 0, duplicateCount: 0, staleCount: 0, rejectedCount: 0,
  gapCount: 0, snapshotCount: 0, reconnectCount: 0, snapshotRequestPending: false, lastMessageAt: null, lastHeartbeatAt: null, heartbeatAgeMs: null,
  activeRuns: [], activeTaskCount: 0, lastError: null, lastRejectionReason: null,
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "warn" }) {
  return <div className="metric"><dt>{label}</dt><dd className={tone ? `tone-${tone}` : ""}>{value}</dd></div>
}

const downloadJson = (name: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export function ProtocolDebugPanel({ controller, directSource, connectSource, onApiChange }: {
  controller: CharacterBehaviorController
  connectSource?: (source: TaskEventSource) => void
  directSource: MockTaskEventSource
  onApiChange?: (api: ProtocolDebugApi | null) => void
}) {
  const [mode, setMode] = useState<SourceMode>("DIRECT_MOCK")
  const [endpointDraft, setEndpointDraft] = useState("ws://127.0.0.1:4174/events")
  const [endpoint, setEndpoint] = useState(endpointDraft)
  const [diagnostics, setDiagnostics] = useState(EMPTY_DIAGNOSTICS)
  const [replayLoadError, setReplayLoadError] = useState<string | null>(null)
  const [runId, setRunId] = useState("protocol-run-001")
  const [taskId, setTaskId] = useState("child-test")
  const runtimeRef = useRef<ProtocolRuntime | null>(null)
  const diagnosticsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const electronProtocol = window.motionLabDesktop?.protocol

  useEffect(() => {
    const previous = runtimeRef.current
    runtimeRef.current = null
    previous?.source.dispose()
    previous?.loopback?.dispose()
    previous?.client.dispose()
    if (diagnosticsTimer.current) clearTimeout(diagnosticsTimer.current)
    diagnosticsTimer.current = null
    setDiagnostics(EMPTY_DIAGNOSTICS)
    setReplayLoadError(null)
    onApiChange?.(null)
    if (mode === "DIRECT_MOCK") {
      (connectSource ?? ((source) => controller.connect(source)))(directSource)
      controller.reset()
      return
    }

    let transport: CharacterEventTransport
    try {
      transport = mode === "PROTOCOL_LOOPBACK"
        ? new InMemoryProtocolTransport()
        : mode === "PROTOCOL_REPLAY"
          ? new ReplayProtocolTransport()
          : mode === "CODEX_ADAPTER" && electronProtocol
            ? new ElectronIpcProtocolTransport(electronProtocol)
            : new WebSocketProtocolTransport(mode === "CODEX_ADAPTER" ? "ws://127.0.0.1:4174/events" : endpoint)
    } catch (error) {
      setDiagnostics({
        ...EMPTY_DIAGNOSTICS,
        connectionState: "ERROR",
        endpoint,
        lastError: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const loopback = transport instanceof InMemoryProtocolTransport ? new ProtocolLoopbackSource(transport) : undefined
    const client = new CharacterEventProtocolClient(transport)
    const source = new ProtocolTaskEventSource(client)
    ;(connectSource ?? ((next) => controller.connect(next)))(source)
    const runtime: ProtocolRuntime = { transport, client, source, ...(loopback ? { loopback } : {}) }
    runtimeRef.current = runtime
    const refresh = () => {
      if (diagnosticsTimer.current) return
      diagnosticsTimer.current = setTimeout(() => {
        diagnosticsTimer.current = null
        if (runtimeRef.current === runtime) setDiagnostics(client.getDiagnostics())
      }, 120)
    }
    const unsubscribe = client.subscribeDiagnostics(refresh)
    const api: ProtocolDebugApi = {
      connect: () => client.connect(),
      disconnect: (reason) => client.disconnect(reason),
      inject: (frame) => { if (transport instanceof InMemoryProtocolTransport) transport.inject(frame) },
      requestSnapshot: () => client.requestSnapshot("manual"),
      getDiagnostics: () => client.getDiagnostics(),
      exportTrace: () => client.exportTrace(),
    }
    onApiChange?.(api)
    setDiagnostics(client.getDiagnostics())
    return () => {
      unsubscribe()
      if (diagnosticsTimer.current) clearTimeout(diagnosticsTimer.current)
      diagnosticsTimer.current = null
      if (runtimeRef.current === runtime) runtimeRef.current = null
      source.dispose()
      loopback?.dispose()
      client.dispose()
      onApiChange?.(null)
    }
  }, [controller, directSource, connectSource, electronProtocol, endpoint, mode, onApiChange])

  const runtime = () => runtimeRef.current
  const connect = () => void runtime()?.client.connect().catch(() => setDiagnostics(runtime()?.client.getDiagnostics() ?? EMPTY_DIAGNOSTICS))
  const loopback = () => runtime()?.loopback
  const replay = () => {
    const transport = runtime()?.transport
    return transport instanceof ReplayProtocolTransport ? transport : null
  }
  const loadReplay = async (file: File | undefined) => {
    if (!file) return
    const transport = replay()
    if (!transport) return
    try {
      const contents = await file.text()
      if (replay() !== transport) return
      transport.load(contents)
      setReplayLoadError(null)
      setDiagnostics(runtime()?.client.getDiagnostics() ?? EMPTY_DIAGNOSTICS)
    } catch (error) {
      if (replay() === transport) setReplayLoadError(error instanceof Error ? error.message : String(error))
    }
  }
  const resetReplay = () => {
    const current = runtime()
    const transport = replay()
    if (!current || !transport) return
    current.client.reset()
    transport.reset()
    void current.client.connect()
  }

  return <details open data-testid="protocol-debug-panel">
    <summary>External event protocol v1</summary>
    <div className="quality-controls protocol-controls">
      <label className="select-label"><span>Source mode</span><select value={mode} onChange={(event) => setMode(event.target.value as SourceMode)}>
        <option value="DIRECT_MOCK">Direct mock</option>
        <option value="PROTOCOL_LOOPBACK">Protocol loopback</option>
        {!electronProtocol && <option value="PROTOCOL_WEBSOCKET">Protocol WebSocket</option>}
        <option value="CODEX_ADAPTER">Codex Adapter</option>
        <option value="PROTOCOL_REPLAY">Protocol replay</option>
      </select></label>
      {mode === "PROTOCOL_WEBSOCKET" && <div className="protocol-endpoint"><label className="select-label"><span>Endpoint</span><input value={endpointDraft} onChange={(event) => setEndpointDraft(event.target.value)} /></label><button className="button button-quiet" type="button" onClick={() => setEndpoint(endpointDraft.trim())}>Apply</button></div>}
      {mode === "CODEX_ADAPTER" && <div className="warning"><b>Codex Adapter</b><span>Expected source: codex-adapter · {electronProtocol ? "secure Electron IPC transport" : "ws://127.0.0.1:4174/events"}</span>{!electronProtocol && <a href="http://127.0.0.1:4175/healthz" target="_blank" rel="noreferrer">Hook observer health</a>}</div>}
      {electronProtocol && mode === "PROTOCOL_WEBSOCKET" && <div className="warning"><b>Unavailable</b><span>Custom WebSocket endpoint is available in browser Motion Lab only.</span></div>}
      <div className="button-row">
        <button className="button button-quiet" type="button" onClick={connect} disabled={mode === "DIRECT_MOCK"}>Connect</button>
        <button className="button button-quiet" type="button" onClick={() => runtime()?.client.disconnect()} disabled={mode === "DIRECT_MOCK"}>Disconnect</button>
        <button className="button button-quiet" type="button" onClick={() => runtime()?.client.requestSnapshot("manual")} disabled={mode === "DIRECT_MOCK"}>Request snapshot</button>
      </div>
      <dl className="metrics-grid">
        <Metric label="Mode" value={mode} />
        <Metric label="Connection" value={diagnostics.connectionState} tone={diagnostics.connectionState === "READY" ? "good" : diagnostics.connectionState === "ERROR" || diagnostics.connectionState === "DESYNCED" ? "warn" : undefined} />
        <Metric label="Connection epoch" value={diagnostics.connectionEpoch} />
        <Metric label="Endpoint" value={diagnostics.endpoint ?? "—"} />
        <Metric label="Protocol / source" value={`${diagnostics.protocolVersion ?? "—"} / ${diagnostics.source ?? "—"}`} />
        <Metric label="Source instance" value={diagnostics.sourceInstanceId ?? "—"} />
        <Metric label="Session" value={diagnostics.sessionId ?? "—"} />
        <Metric label="Last sequence" value={diagnostics.lastAppliedSequence} />
        <Metric label="Heartbeat age" value={diagnostics.heartbeatAgeMs === null ? "—" : `${Math.round(diagnostics.heartbeatAgeMs)} ms`} />
        <Metric label="Accepted / rejected" value={`${diagnostics.acceptedCount} / ${diagnostics.rejectedCount}`} />
        <Metric label="Duplicate / stale" value={`${diagnostics.duplicateCount} / ${diagnostics.staleCount}`} />
        <Metric label="Gaps / buffered" value={`${diagnostics.gapCount} / ${diagnostics.bufferedFrameCount}`} />
        <Metric label="Snapshots / reconnects" value={`${diagnostics.snapshotCount} / ${diagnostics.reconnectCount}`} />
        <Metric label="Snapshot pending" value={diagnostics.snapshotRequestPending ? "yes" : "no"} tone={diagnostics.snapshotRequestPending ? "warn" : undefined} />
      </dl>
      {replayLoadError && <div className="warning"><b>Replay load failed</b><span>{replayLoadError}</span></div>}
      {(diagnostics.lastRejectionReason || diagnostics.lastError) && <div className="warning"><b>Protocol diagnostics</b>{diagnostics.lastRejectionReason && <span>Rejected: {diagnostics.lastRejectionReason}</span>}{diagnostics.lastError && <span>Error: {diagnostics.lastError}</span>}</div>}
      {mode === "CODEX_ADAPTER" && diagnostics.source && diagnostics.source !== "codex-adapter" && <div className="warning"><b>Unexpected source</b><span>Received {diagnostics.source}; expected codex-adapter.</span></div>}
      {!!diagnostics.activeRuns.length && <div className="warning"><b>Active runs</b>{diagnostics.activeRuns.map((run) => <span key={run.runId}>{run.runId} · {run.progress === undefined ? "—" : `${Math.round(run.progress * 100)}%`} · tasks [{run.runningTaskIds.join(", ") || "—"}] · failed [{run.failedTaskIds.join(", ") || "—"}]</span>)}</div>}

      {mode === "PROTOCOL_LOOPBACK" && <>
        <label className="select-label"><span>Run ID</span><input value={runId} onChange={(event) => setRunId(event.target.value)} /></label>
        <label className="select-label"><span>Child task ID</span><input value={taskId} onChange={(event) => setTaskId(event.target.value)} /></label>
        <div className="button-row behavior-buttons">
          <button className="button button-quiet" type="button" onClick={() => loopback()?.startRun(runId)}>Valid Run Start</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.waitRun(runId)}>Valid Run Waiting</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.resumeRun(runId)}>Valid Run Resume</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.completeRun(runId)}>Valid Run Complete</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.failRun(runId)}>Valid Run Fail</button>
          <button className="button button-quiet" type="button" onClick={() => { loopback()?.startTask(runId, taskId); loopback()?.failTask(runId, taskId) }}>Child Task Fail</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.duplicateLast()}>Duplicate Last Frame</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendOutOfOrder()}>Out-of-order Frame</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendGap()}>Sequence Gap</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendSnapshot()}>Authoritative Snapshot</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.restartSource()}>Restart Source Instance</button>
          <button className="button button-quiet" type="button" onClick={() => (runtime()?.transport as InMemoryProtocolTransport | undefined)?.drop()}>Drop Connection</button>
          <button className="button button-quiet" type="button" onClick={connect}>Reconnect</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendMalformed()}>Malformed JSON</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendInvalidProgress()}>Invalid Progress</button>
          <button className="button button-quiet" type="button" onClick={() => loopback()?.sendUnsupportedVersion()}>Unsupported Version</button>
        </div>
      </>}

      {mode === "PROTOCOL_REPLAY" && <>
        <label className="select-label"><span>Replay JSON / JSONL</span><input type="file" accept=".json,.jsonl,application/json" onChange={(event) => {
          const input = event.currentTarget
          void loadReplay(input.files?.[0]).finally(() => { input.value = "" })
        }} /></label>
        <div className="button-row">
          <button className="button button-quiet" type="button" onClick={() => replay()?.play()}>Play</button>
          <button className="button button-quiet" type="button" onClick={() => replay()?.pause()}>Pause</button>
          <button className="button button-quiet" type="button" onClick={() => replay()?.step()}>Step</button>
          <button className="button button-quiet" type="button" onClick={resetReplay}>Reset</button>
          {([0.5, 1, 2] as const).map((speed) => <button key={speed} className="button button-quiet" type="button" onClick={() => replay()?.setSpeed(speed)}>{speed}x</button>)}
        </div>
      </>}

      <div className="button-row">
        <button className="button button-quiet" type="button" onClick={() => runtime() && downloadJson("protocol-trace.json", runtime()!.client.exportTrace())} disabled={mode === "DIRECT_MOCK"}>Export protocol trace</button>
        <button className="button button-quiet" type="button" onClick={() => runtime() && downloadJson("protocol-snapshot.json", runtime()!.client.getRuntimeSnapshot())} disabled={mode === "DIRECT_MOCK"}>Export current snapshot</button>
        <button className="button button-quiet" type="button" onClick={() => downloadJson("protocol-diagnostics.json", diagnostics)} disabled={mode === "DIRECT_MOCK"}>Export diagnostics</button>
      </div>
    </div>
  </details>
}
