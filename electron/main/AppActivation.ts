import type { App } from "electron"

export type PetActivationController = {
  showPet(): void
  activate?(): void
}

export function registerActivationHandler(
  app: Pick<App, "on" | "removeListener">,
  getController: () => PetActivationController | null,
): () => void {
  const onActivate = () => { const controller = getController(); if (controller?.activate) controller.activate(); else controller?.showPet() }
  app.on("activate", onActivate)
  return () => app.removeListener("activate", onActivate)
}
