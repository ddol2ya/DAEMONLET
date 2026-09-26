import { useEffect, useRef, useState } from "react"
import { emptyCodexUsage, newerCodexUsage, type CodexUsageApi, type CodexUsageSnapshot } from "../../electron/shared/codex-usage-contract"
declare global { interface Window { codexUsageDesktop?: CodexUsageApi } }
/** Buffer every update, including enable/disable, under the existing input lock. */
export function useCodexUsage(locked: () => boolean) {
  const [snapshot, setSnapshot] = useState(emptyCodexUsage)
  const latest = useRef(snapshot), lock = useRef(locked); lock.current = locked
  const flush = () => { if (!lock.current()) setSnapshot(latest.current) }
  useEffect(() => {
    const api = window.codexUsageDesktop
    if (!api) return
    let alive = true
    const receive = (value: CodexUsageSnapshot) => { if (alive) { latest.current = newerCodexUsage(latest.current, value); flush() } }
    const off = api.onChanged(receive)
    void api.getSnapshot().then(result => { if (result.ok) receive(result.value) }).catch(() => {})
    return () => { alive = false; off() }
  }, [])
  return { snapshot, flush }
}
