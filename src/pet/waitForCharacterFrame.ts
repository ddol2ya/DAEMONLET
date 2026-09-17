/** The runtime renders in rAF. A second callback observes a completed render turn. */
export function waitForCharacterFrame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0
    const abort = () => { cancelAnimationFrame(frame); signal.removeEventListener("abort", abort); reject(new DOMException("Character load cancelled", "AbortError")) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener("abort", abort, { once: true })
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { signal.removeEventListener("abort", abort); resolve() })
    })
  })
}
