import type { App } from "electron"

export type PetActivationController = {
  showPet(): void
}

export function registerActivationHandler(
  app: Pick<App, "on" | "removeListener">,
  getController: () => PetActivationController | null,
): () => void {
  const onActivate = () => getController()?.showPet()
  app.on("activate", onActivate)
  return () => app.removeListener("activate", onActivate)
}
