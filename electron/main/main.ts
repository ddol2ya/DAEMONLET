import { app } from "electron"
import { join } from "node:path"
import { mkdir, realpath } from "node:fs/promises"
import { registerActivationHandler } from "./AppActivation"
import { AppController } from "./AppController"
import { installAppProtocol, registerAppScheme } from "./AppProtocol"
import { createSetupSmokeContext } from "./SetupSmoke"
import { CharacterRegistry } from "./CharacterRegistry"
import { createPackValidator } from "./CharacterPackWorker"
import { prepareDesktopAdapterPorts } from "./DesktopAdapterConfig"

import { configureDesktopIdentity } from "./DesktopIdentity"

const currentDirectory = __dirname
registerAppScheme()
app.enableSandbox()
configureDesktopIdentity(app)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  process.env.ELECTRON_ENABLE_SECURITY_WARNINGS = "true"
  process.env.ELECTRON_IS_PACKAGED = app.isPackaged ? "1" : ""
  let controller: AppController | null = null
  registerActivationHandler(app, () => controller)
  app.on("second-instance", () => controller?.showPet())
  app.on("window-all-closed", () => { /* The tray owns application lifetime. */ })
  app.on("before-quit", (event) => {
    if (!controller) return
    event.preventDefault()
    const active = controller
    controller = null
    void active.quit()
  })
  void app.whenReady().then(async () => {
    await prepareDesktopAdapterPorts()
    await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 })
    app.setPath("userData", await realpath(app.getPath("userData")))
    const appRoot = app.isPackaged ? app.getAppPath() : join(currentDirectory, "..")
    const dataRoot = join(appRoot, app.isPackaged ? "dist" : "public")
    const characters = new CharacterRegistry(app.getPath("userData"), join(dataRoot, "characters"), createPackValidator(join(currentDirectory, "character-pack-worker.cjs")))
    await characters.initialize()
    const devOrigin = !app.isPackaged && process.env.VITE_DEV_SERVER_URL ? new URL(process.env.VITE_DEV_SERVER_URL).origin : undefined
    // Vite serves development HTML; standalone smoke uses the built renderer.
    // CharacterRegistry still reads the authoring catalog from public in dev.
    installAppProtocol(devOrigin ? dataRoot : join(appRoot, "dist"), undefined, characters, devOrigin)
    const readyController = new AppController(currentDirectory, characters, __SETUP_SMOKE__ ? await createSetupSmokeContext() : undefined)
    await readyController.start()
    controller = readyController
  }).catch((error) => {
    console.error(error)
    app.exit(1)
  })
}
