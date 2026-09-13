import { describe, expect, it } from "vitest"
import { rolloutSessionId } from "../adapter/codex/lifecycle/CodexRolloutPath"
import { belongsToLocalCodexHome, sameLocalCodexConversationPath } from "../electron/main/control/CodexThreadLauncher"
const id = "11111111-1111-4111-8111-111111111111", segment = "22222222-2222-4222-8222-222222222222"
const old = `/tmp/codex/sessions/2026/09/11/rollout-2026-09-11T00-00-00-${id}.jsonl`
const next = `/tmp/codex/sessions/2026/09/12/rollout-2026-09-12T00-00-00-${id}_${segment}.jsonl`
describe("continued Codex rollout paths", () => {
  it.runIf(process.platform === "win32")("accepts native Windows paths and rejects another home or drive", () => {
    const home = "C:\\Users\\example-user\\.codex"
    const first = `${home}\\sessions\\2026\\09\\11\\rollout-2026-09-11T00-00-00-${id}.jsonl`
    const continued = `${home}\\sessions\\2026\\09\\12\\rollout-2026-09-12T00-00-00-${id}_${segment}.jsonl`
    expect(belongsToLocalCodexHome(continued, id, home)).toBe(true)
    expect(sameLocalCodexConversationPath(first, continued, id)).toBe(true)
    expect(belongsToLocalCodexHome(continued.replace("C:", "D:"), id, home)).toBe(false)
    expect(belongsToLocalCodexHome(continued.replace("\\sessions\\", "\\sessions\\..\\outside\\"), id, home)).toBe(false)
  })
  it("retains conversation identity across continuation files and days", () => {
    expect(rolloutSessionId(next)).toBe(id)
    expect(belongsToLocalCodexHome(next, id, "/tmp/codex")).toBe(true)
    expect(belongsToLocalCodexHome(next, segment, "/tmp/codex")).toBe(false)
    expect(sameLocalCodexConversationPath(old, next, id)).toBe(true)
  })
  it("rejects malformed suffixes, different conversations and other homes", () => {
    for (const path of [next.replace(`_${segment}`, "_garbage"), next.replace(`_${segment}`, `_${segment}_${segment}`), next.replace("/sessions/", "/sessions/../outside/")]) expect(belongsToLocalCodexHome(path, id, "/tmp/codex")).toBe(false)
    expect(sameLocalCodexConversationPath(old, next.replace("/tmp/codex/", "/other/"), id)).toBe(false)
    expect(sameLocalCodexConversationPath(old, next.replace(id, segment), id)).toBe(false)
  })
})
