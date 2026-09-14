import { app, dialog } from "electron"
import { join } from "node:path"
import { mkdir, realpath } from "node:fs/promises"
import { registerActivationHandler } from "./AppActivation"
import { AppController } from "./AppController"
import { installAppProtocol, registerAppScheme } from "./AppProtocol"
import { createSetupSmokeContext } from "./SetupSmoke"
import { CharacterRegistry } from "./CharacterRegistry"
import { createPackValidator } from "./CharacterPackWorker"
import { prepareDesktopAdapterPorts } from "./DesktopAdapterConfig"

import { StartupWindow } from "./StartupWindow"
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
  const startup = new StartupWindow()
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
    await startup.open()
    await prepareDesktopAdapterPorts()
    await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 })
    app.setPath("userData", await realpath(app.getPath("userData")))
    const appRoot = app.isPackaged ? app.getAppPath() : join(currentDirectory, "..")
    const dataRoot = join(appRoot, app.isPackaged ? "dist" : "public")
    const characters = new CharacterRegistry(app.getPath("userData"), join(dataRoot, "characters"), createPackValidator(join(currentDirectory, "character-pack-worker.cjs")))
    await characters.initialize({ deferRig: true })
    const devOrigin = !app.isPackaged && process.env.VITE_DEV_SERVER_URL ? new URL(process.env.VITE_DEV_SERVER_URL).origin : undefined
    // Vite serves development HTML; standalone smoke uses the built renderer.
    // CharacterRegistry still reads the authoring catalog from public in dev.
    installAppProtocol(devOrigin ? dataRoot : join(appRoot, "dist"), undefined, characters, devOrigin)
    const readyController = new AppController(currentDirectory, characters, __SETUP_SMOKE__ ? await createSetupSmokeContext() : undefined, startup)
    await readyController.start()
    controller = readyController
  }).catch((error) => {
    console.error(error)
    startup.close()
    dialog.showErrorBox("Daemonlet을 시작하지 못했습니다", "앱을 다시 실행해 주세요. 문제가 계속되면 진단을 확인해 주세요.")
    app.exit(1)
  })
}
