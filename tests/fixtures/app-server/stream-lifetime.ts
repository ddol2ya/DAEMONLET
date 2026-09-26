// Runs in a separate process. No uncaughtException/unhandledRejection handlers:
// a missed stream error must fail the regression rather than hide in Vitest.
import assert from "node:assert/strict"
import { PassThrough, Writable } from "node:stream"
import { setImmediate as tick } from "node:timers/promises"
import { AppServerJsonlClient } from "../../../adapter/codex/app-server/AppServerJsonlClient"

const scenario = process.argv[2]
const readable = new PassThrough()
let complete!: (error?: Error | null) => void
const writable = new Writable({ highWaterMark: scenario === "backpressure" ? 1 : 16384,
  write(_chunk, _encoding, callback) { complete = callback } })
const client = new AppServerJsonlClient({ readable, writable })
let closes = 0
client.onClose(() => { closes++ })
const pending = client.request("account/read", { refreshToken: false }).then(() => "unexpected", e => e.message)
if (scenario === "readable-end") { readable.end(); await tick() }
else if (scenario === "readable-error") { readable.destroy(Error("read failure")); await tick() }
else if (scenario === "backpressure") assert.equal(writable.listenerCount("drain"), 1)
client.close(); client.close()
assert.notEqual(await pending, "unexpected")
assert.equal(closes, 1)
assert.equal(client.pendingRequestCount, 0)
assert.equal(readable.listenerCount("data"), 0)
assert.equal(readable.listenerCount("end"), 0)
assert.equal(writable.listenerCount("drain"), 0)
assert.equal(writable.listenerCount("error"), 1)
complete(Object.assign(Error("write failed after cancellation"), { code: "EPIPE" }))
await tick()
assert.equal(writable.closed, true)
assert.equal(writable.listenerCount("error"), 0)
readable.destroy()
await tick()
assert.equal(readable.listenerCount("error"), 0)
assert.equal(readable.listenerCount("close"), 0)
assert.equal(writable.listenerCount("close"), 0)
console.log("stream-lifetime:passed")
