import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { CharacterDialogueController } from "../../src/dialogue/CharacterDialogueController"
import { useBubblePresentation } from "../../src/pet/useBubblePresentation"

// Only the synthetic cue and geometry are fixtures. Lifetime, React reporting,
// sandboxed preload, IPC validation and native bubble windows are production code.
const dialogue = new CharacterDialogueController({ random: () => 0 })
dialogue.configure({ warnings: [], manifest: {
  schemaVersion: 1, locale: "ko-KR",
  settings: { defaultDisplayMs: 1800, fadeMs: 100, minGapMs: 0, maxQueueSize: 1, repeatMemory: 0, maxCharacters: 36 },
  triggers: { "interaction.head-tap": { priority: 1, probability: 1, cooldownMs: 0, mode: "replace-lower", lines: ["검사용 대사입니다."] } },
} }, "synthetic-pet")
const anchor = { x0: .3, x1: .7, y0: .02, y1: .32 }, size = { width: 180, height: 52 }
function Pet() {
  const [snapshot, setSnapshot] = useState(() => dialogue.getSnapshot())
  useEffect(() => dialogue.subscribe(() => setSnapshot(dialogue.getSnapshot())), [])
  const granted = useBubblePresentation(snapshot, anchor, true, true, 1, dialogue, size)
  return <main data-phase={snapshot.phase} data-granted={granted}><p>합성 Pet · 실제 대사 타이머/IPC</p><button onClick={() => dialogue.triggerDebug("interaction.head-tap")}>대사 시작</button></main>
}
createRoot(document.getElementById("root")!).render(<Pet />)
