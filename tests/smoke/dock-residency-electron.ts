import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { DockResidencyController } from "../../electron/main/DockResidencyController"
app.setPath("userData", process.env.DAEMONLET_DOCK_PROFILE!)
app.on("window-all-closed", () => {})
async function main() {
  await app.whenReady()
  assert.equal(process.platform, "darwin", "macOS Dock test")
  const pet = new BrowserWindow({ width: 160, height: 160, show: false, skipTaskbar: true })
  let settings: BrowserWindow | null = null, lab: BrowserWindow | null = null, reachable = false, recovered = false
  const controller = new DockResidencyController({ app, windows: () => BrowserWindow.getAllWindows(), utilityWindows: () => [settings, lab],
    trayCreated: () => true, trayVisible: () => reachable, recovered: () => { recovered = true } })
  const until = async (condition: () => boolean) => { for (let n = 0; n < 100; n++) { if (condition()) return; await new Promise(r => setTimeout(r, 20)) }; throw Error("Dock visibility timed out") }
  try {
    controller.start(); pet.showInactive(); await until(() => !app.dock!.isVisible())
    settings = new BrowserWindow({ width: 400, height: 300, show: false })
    await settings.loadURL("data:text/html,<h1>Isolated Dock residency test</h1>")
    settings.show(); controller.requestFallback(); await until(() => app.dock!.isVisible())
    lab = new BrowserWindow({ width: 200, height: 200 }); settings.close()
    await new Promise(r => setTimeout(r, 100)); assert(app.dock!.isVisible(), "remaining utility window retains temporary Dock")
    lab.close(); await until(() => !app.dock!.isVisible()); assert(pet.isVisible(), "pet remains visible")
    settings = new BrowserWindow({ width: 400, height: 300 })
    await until(() => app.dock!.isVisible())
    reachable = true; controller.sync(); await until(() => !app.dock!.isVisible())
    assert(recovered && settings.isVisible(), "tray recovery preserves open user UI")
    settings.close(); await until(() => !app.dock!.isVisible())
    await writeFile(process.env.DAEMONLET_DOCK_RESULT!, JSON.stringify({ status: "PASS", electron: process.versions.electron,
      checks: ["native Dock visible during recovery window", "last utility close hides Dock with pet alive", "new utility window lifecycle", "tray recovery hides Dock without closing UI"],
      trayGeometry: "controlled fixture", windowsAndDock: "actual Electron/macOS", modelCalls: 0 }, null, 2))
  } finally { controller.dispose(); for (const win of BrowserWindow.getAllWindows()) win.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
