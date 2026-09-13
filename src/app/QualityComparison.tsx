import { useEffect, useRef } from "react"
import type { QualityMode, RigImage } from "../engine/anime25d/types"

export function QualityComparison({ mode, image, sourceUrl }: { mode: QualityMode; image: RigImage | null; sourceUrl: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const compositeMode = mode === "RAW_PSD_COMPOSITE" || mode === "CLEANED_PSD_COMPOSITE"
  const sourceMode = mode === "SOURCE_REFERENCE"

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || (!compositeMode && !sourceMode)) return
    const context = canvas.getContext("2d")
    if (!context) return
    if (compositeMode && image) {
      canvas.width = image.width
      canvas.height = image.height
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
      return
    }
    if (sourceMode && sourceUrl) {
      const source = new Image()
      source.onload = () => {
        canvas.width = source.naturalWidth
        canvas.height = source.naturalHeight
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(source, 0, 0)
      }
      source.src = sourceUrl
    }
  }, [compositeMode, image, sourceMode, sourceUrl])

  if (!compositeMode && !sourceMode) return null
  return <canvas ref={canvasRef} className="quality-comparison-canvas" aria-label={`${mode} preview`} data-testid="quality-comparison" />
}
