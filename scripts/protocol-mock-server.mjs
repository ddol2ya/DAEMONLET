import { createInterface } from "node:readline"
import { randomUUID } from "node:crypto"
import { WebSocketServer } from "ws"

const host = process.env.PROTOCOL_MOCK_HOST || "127.0.0.1"
const port = Number(process.env.PROTOCOL_MOCK_PORT || 4174)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PROTOCOL_MOCK_PORT must be a valid TCP port")
if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("PROTOCOL_MOCK_HOST must be a loopback host")

const state = {
  sourceInstanceId: randomUUID(),
  sessionId: `mock-session-${Date.now()}`,
  sequence: 0,
  message: 0,
  reuseMessageIds: false,
  messageCounters: new Map(),
  activeRuns: new Map(),
  lastFrame: null,
}

const wss = new WebSocketServer({ host, port, path: "/events", maxPayload: 64 * 1024 })
const resetMessageCounters = () => {
  state.message = 0
  state.messageCounters.clear()
}
const nextMessageId = (frameType) => {
  if (!state.reuseMessageIds) return `mock-${++state.message}-${randomUUID()}`
  const sequence = (state.messageCounters.get(frameType) || 0) + 1
  state.messageCounters.set(frameType, sequence)
  return `${frameType}-${sequence}`
}
const base = (frameType) => ({
  protocolVersion: 1,
  frameType,
  messageId: nextMessageId(frameType),
  source: "mock-bridge",
  sourceInstanceId: state.sourceInstanceId,
  sessionId: state.sessionId,
  sentAt: Date.now(),
})
const clients = () => [...wss.clients].filter((socket) => socket.readyState === 1)
const canonicalId = (value) => typeof value === "string" && value.length >= 1 && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
const send = (socket, frame) => socket.send(JSON.stringify(frame))
const broadcast = (frame) => {
  state.lastFrame = structuredClone(frame)
  for (const socket of clients()) send(socket, frame)
}
const hello = () => {
  const envelope = base("hello")
  return {
    ...envelope,
    payload: {
      sourceName: "Daemonlet Protocol Mock Bridge",
      supportedProtocolVersions: [1],
      capabilities: ["snapshot", "heartbeat", "runs", "tasks", "progress", "replay"],
      heartbeatIntervalMs: 5_000,
    },
  }
}
const snapshot = () => {
  const envelope = base("snapshot")
  return {
    ...envelope,
    sequence: ++state.sequence,
    payload: {
      snapshotId: randomUUID(),
      activeRuns: [...state.activeRuns.values()].map((run) => ({
        runId: run.runId,
        ...(run.label ? { label: run.label } : {}),
        ...(run.progress === undefined ? {} : { progress: run.progress }),
        tasks: [...run.tasks.values()].map((task) => ({ ...task, status: "running" })),
      })),
    },
  }
}
const event = (payload) => {
  const envelope = base("event")
  return { ...envelope, sequence: ++state.sequence, payload }
}

wss.on("connection", (socket) => {
  socket.on("message", (data, isBinary) => {
    if (isBinary || data.length > 64 * 1024) return socket.close(1003, "text JSON frames only")
    let command
    try { command = JSON.parse(data.toString("utf8")) } catch { return }
    if (!command || command.protocolVersion !== 1 || !canonicalId(command.requestId)) return
    if (command.commandType === "client.hello" && canonicalId(command.clientId) && Array.isArray(command.supportedProtocolVersions) && command.supportedProtocolVersions.includes(1)) send(socket, hello())
    if (command.commandType === "snapshot.request") send(socket, snapshot())
    if (command.commandType === "client.ping") send(socket, { ...base("heartbeat"), payload: { heartbeatId: command.requestId } })
  })
})

const heartbeat = setInterval(() => broadcast({ ...base("heartbeat"), payload: { heartbeatId: randomUUID() } }), 5_000)
heartbeat.unref()

const parseProgress = (value) => {
  const progress = Number(value)
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error("progress must be from 0 to 1")
  return progress
}
const requireRun = (runId) => {
  const run = state.activeRuns.get(runId)
  if (!run) throw new Error(`unknown active run: ${runId}`)
  return run
}
const help = () => console.log(`Commands:
  run-start <runId> [label]
  run-progress <runId> <0..1>
  run-complete|run-fail|run-cancel <runId> [message]
  task-start|task-progress|task-complete|task-fail <runId> <taskId> [progress]
  snapshot | duplicate | gap | restart-source | disconnect
  reuse-message-ids on|off | help`)

const cli = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
cli.on("line", (line) => {
  const [command, runId, taskId, ...rest] = line.trim().split(/\s+/)
  if (!command) return
  try {
    if (command === "help") return help()
    if (command === "reuse-message-ids") {
      if (runId !== "on" && runId !== "off") throw new Error("reuse-message-ids expects on or off")
      state.reuseMessageIds = runId === "on"
      resetMessageCounters()
      console.log(`Reusable message IDs ${state.reuseMessageIds ? "enabled" : "disabled"}`)
      return
    }
    if (command === "snapshot") return broadcast(snapshot())
    if (command === "duplicate") {
      if (state.lastFrame) for (const socket of clients()) send(socket, state.lastFrame)
      return
    }
    if (command === "gap") {
      state.sequence++
      return broadcast(event({ type: "run.progress", runId: runId || [...state.activeRuns.keys()][0] || "gap-run", progress: 0.5 }))
    }
    if (command === "restart-source") {
      state.sourceInstanceId = randomUUID()
      state.sequence = 0
      if (state.reuseMessageIds) resetMessageCounters()
      return broadcast(hello())
    }
    if (command === "disconnect") {
      for (const socket of clients()) socket.close(1012, "simulated restart")
      if (state.reuseMessageIds) resetMessageCounters()
      return
    }
    if (!runId) throw new Error("runId is required")
    if (command === "run-start") {
      state.activeRuns.set(runId, { runId, label: [taskId, ...rest].filter(Boolean).join(" ") || undefined, tasks: new Map() })
      return broadcast(event({ type: "run.started", runId, ...([taskId, ...rest].filter(Boolean).length ? { label: [taskId, ...rest].join(" ") } : {}) }))
    }
    const run = requireRun(runId)
    if (command === "run-progress") {
      run.progress = parseProgress(taskId)
      return broadcast(event({ type: "run.progress", runId, progress: run.progress }))
    }
    if (["run-complete", "run-fail", "run-cancel"].includes(command)) {
      state.activeRuns.delete(runId)
      const type = command === "run-complete" ? "run.completed" : command === "run-fail" ? "run.failed" : "run.cancelled"
      const detail = [taskId, ...rest].filter(Boolean).join(" ")
      return broadcast(event({ type, runId, ...(type === "run.failed" && detail ? { message: detail } : type === "run.cancelled" && detail ? { reason: detail } : {}) }))
    }
    if (!taskId) throw new Error("taskId is required")
    if (command === "task-start") {
      run.tasks.set(taskId, { taskId })
      return broadcast(event({ type: "task.started", runId, taskId }))
    }
    if (command === "task-progress") {
      const progress = parseProgress(rest[0])
      const task = run.tasks.get(taskId)
      if (task) task.progress = progress
      return broadcast(event({ type: "task.progress", runId, taskId, progress }))
    }
    if (["task-complete", "task-fail"].includes(command)) {
      run.tasks.delete(taskId)
      return broadcast(event({ type: command === "task-complete" ? "task.completed" : "task.failed", runId, taskId }))
    }
    throw new Error(`unknown command: ${command}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
  }
})

wss.on("listening", () => {
  console.log(`Protocol mock bridge listening at ws://${host}:${port}/events`)
  help()
})
wss.on("error", (error) => {
  console.error(error.message)
  process.exitCode = 1
  clearInterval(heartbeat)
  cli.close()
})

const shutdown = () => {
  clearInterval(heartbeat)
  cli.close()
  for (const socket of wss.clients) socket.terminate()
  wss.close()
}
cli.on("SIGINT", shutdown)
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
