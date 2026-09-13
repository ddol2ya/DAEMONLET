import type { App } from "electron"
import { join, resolve } from "node:path"
import { APP_NAME, BUNDLE_ID } from "../shared/app-identity.mjs"

/** Run before the single-instance lock and before Chromium starts.
 * Never migrate the regular app's settings, imported packs or browser storage. */
export function configureDesktopIdentity(app: Pick<App, "isPackaged" | "setName" | "getPath" | "setPath" | "setAppUserModelId">,
  environment: NodeJS.ProcessEnv = process.env, platform = process.platform): void {
  const name = app.isPackaged ? APP_NAME : `${APP_NAME} Dev`
  app.setName(name)
  const userData = environment.ELECTRON_SMOKE_USER_DATA
    ? resolve(environment.ELECTRON_SMOKE_USER_DATA)
    : join(app.getPath("appData"), name)
  app.setPath("userData", userData)
  app.setPath("sessionData", userData)
  if (platform === "win32") app.setAppUserModelId(app.isPackaged ? BUNDLE_ID : `${BUNDLE_ID}.dev`)
  environment.CODEX_PET_DATA_DIR ??= join(userData, "adapter")
  // macOS Hooks need stable endpoints across restarts; development gets its own.
  if (!app.isPackaged && platform !== "win32") {
    environment.CODEX_PET_PROTOCOL_PORT ??= "4574"
    environment.CODEX_PET_HOOK_PORT ??= "4575"
  }
}
