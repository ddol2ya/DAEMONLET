export type ContainTransform = {
  scale: number
  offsetX: number
  offsetY: number
  renderedWidth: number
  renderedHeight: number
}

export function containTransform(viewportWidth: number, viewportHeight: number, modelWidth: number, modelHeight: number): ContainTransform {
  const scale = Math.min(viewportWidth / modelWidth, viewportHeight / modelHeight)
  const renderedWidth = modelWidth * scale
  const renderedHeight = modelHeight * scale
  return { scale, renderedWidth, renderedHeight, offsetX: (viewportWidth - renderedWidth) / 2, offsetY: (viewportHeight - renderedHeight) / 2 }
}

export function viewportToModel(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  modelWidth: number,
  modelHeight: number,
): { x: number; y: number; inside: boolean } {
  const transform = containTransform(viewportWidth, viewportHeight, modelWidth, modelHeight)
  const rawX = (x - transform.offsetX) / transform.scale
  const rawY = (y - transform.offsetY) / transform.scale
  const epsilon = 1e-9
  const inside = rawX >= -epsilon && rawX <= modelWidth + epsilon && rawY >= -epsilon && rawY <= modelHeight + epsilon
  const modelX = inside ? Math.max(0, Math.min(modelWidth, rawX)) : rawX
  const modelY = inside ? Math.max(0, Math.min(modelHeight, rawY)) : rawY
  return { x: modelX, y: modelY, inside }
}

export function clientToModel(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  modelWidth: number,
  modelHeight: number,
) {
  return viewportToModel(clientX - rect.left, clientY - rect.top, rect.width, rect.height, modelWidth, modelHeight)
}

export function modelToViewport(x: number, y: number, viewportWidth: number, viewportHeight: number, modelWidth: number, modelHeight: number) {
  const transform = containTransform(viewportWidth, viewportHeight, modelWidth, modelHeight)
  return { x: x * transform.scale + transform.offsetX, y: y * transform.scale + transform.offsetY }
}

export function modelToClient(x: number, y: number, rect: Pick<DOMRect, "left" | "top" | "width" | "height">, modelWidth: number, modelHeight: number) {
  const point = modelToViewport(x, y, rect.width, rect.height, modelWidth, modelHeight)
  return { x: point.x + rect.left, y: point.y + rect.top }
}
