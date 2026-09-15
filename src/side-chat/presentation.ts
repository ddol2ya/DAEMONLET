export function requiresPanel(text: string, measuredHeight: number, lineHeight: number): boolean {
  return /(^|\n)\s*(```|~~~)|(^|\n)\s*\|.*\||(^|\n)\s*\S.*\|.*\n\s*[-: ]+\|/.test(text) || !Number.isFinite(measuredHeight) || lineHeight <= 0 || measuredHeight > lineHeight * 5 + 1
}
export function isComposing(event: { isComposing?: boolean; keyCode?: number }): boolean { return Boolean(event.isComposing || event.keyCode === 229) }
