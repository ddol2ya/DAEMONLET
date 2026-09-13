/** Shrink wrapped text to its rendered lines without adding lines or splitting
 * words that already fit. The caller uses a hidden measurement element. */
export function fitSpeechBubbleSize(bubble: HTMLElement, maximumWidth: number): { width: number; height: number } {
  const previousWidth = bubble.style.width
  try {
    bubble.style.width = `${maximumWidth}px`
    const initialHeight = bubble.getBoundingClientRect().height
    const style = getComputedStyle(bubble)
    const inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
    const range = document.createRange()
    range.selectNodeContents(bubble.querySelector("span") ?? bubble)
    let width = maximumWidth
    for (let attempt = 0; attempt < 6; attempt++) {
      const inkWidth = Math.max(0, ...Array.from(range.getClientRects(), rect => rect.width))
      if (!inkWidth) break
      // One CSS pixel protects fractional glyph widths when the measured box
      // is recreated in the companion renderer.
      const next = Math.ceil(inkWidth + inset) + 1
      if (next >= width) break
      bubble.style.width = `${next}px`
      if (bubble.getBoundingClientRect().height > initialHeight + .5) {
        bubble.style.width = `${width}px`
        break
      }
      width = next
    }
    return { width, height: Math.ceil(bubble.getBoundingClientRect().height) }
  } finally { bubble.style.width = previousWidth }
}
