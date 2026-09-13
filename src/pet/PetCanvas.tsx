import { forwardRef } from "react"

export const PetCanvas = forwardRef<HTMLCanvasElement>(function PetCanvas(_props, ref) {
  return <canvas ref={ref} aria-label="Daemonlet desktop pet" />
})
