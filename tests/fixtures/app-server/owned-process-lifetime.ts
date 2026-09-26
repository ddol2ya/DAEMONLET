import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setImmediate as tick } from "node:timers/promises"
import { AppServerProcess } from "../../../adapter/codex/app-server/AppServerProcess"
import { startChatProcess } from "../../../electron/main/side-chat/ChatProcess"

const root = await mkdtemp(join(tmpdir(), "owned-jsonl-lifetime-")), original = process.cwd()
const peer = join(root, "app-server")
// Synthetic child, not a Codex process: deliberately do not consume stdin.
await writeFile(peer, 'process.stdout.write(JSON.stringify({method:"fixture/ready",params:{pid:process.pid}})+"\\n");setInterval(()=>{},1000)')
try {
  process.chdir(root)
  for (const kind of ["observer", "chat"]) {
    const observer = kind === "observer" ? new AppServerProcess(process.execPath) : null
    const chat = kind === "chat" ? startChatProcess(process.execPath, [peer], root, process.env) : null
    const client = observer ? await observer.start() : chat!.client
    const pid = await new Promise<number>(resolve => { const off = client.onNotification((method, params) => { if (method === "fixture/ready") { off(); resolve((params as { pid: number }).pid) } }) })
    const request = client.request("account/read", { fixture: "x".repeat(1024 * 1024) }).then(() => "unexpected", () => "closed")
    const stop = () => observer ? observer.stop() : chat!.stop()
    await Promise.all([stop(), stop()]); await tick()
    assert.equal(await request, "closed")
    assert.equal(client.pendingRequestCount, 0)
    assert.equal(client.handshakeState, "CLOSED")
    assert.throws(() => process.kill(pid, 0))
    await stop()
  }
  console.log("owned-process-lifetime:passed")
} finally { process.chdir(original); await rm(root, { recursive: true, force: true }) }
