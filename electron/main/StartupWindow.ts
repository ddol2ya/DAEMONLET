import { BrowserWindow } from "electron"
import type { PackProgress } from "../shared/character-pack-contract"

/** Shown before any external model decoding; no renderer privileges or network. */
export class StartupWindow {
  private window: BrowserWindow | null = null
  async open() {
    const win = this.window = new BrowserWindow({ width: 400, height: 200, resizable: false, minimizable: false, maximizable: false, show: false, title: "Daemonlet 시작 중", backgroundColor: "#f7f8f4", webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } })
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    win.webContents.on("will-navigate", event => event.preventDefault())
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Daemonlet 시작 중</title><style>body{margin:0;padding:32px;font:15px system-ui;color:#293d34;background:#f7f8f4}h1{font-size:20px;margin:0 0 16px}p{line-height:1.6;margin:8px 0;color:#52645b}.spinner{display:inline-block;width:16px;height:16px;border:3px solid #dce4dd;border-top-color:#286857;border-radius:50%;vertical-align:middle;margin-right:12px;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}</style><h1><span class="spinner" aria-hidden="true"></span>Daemonlet 시작 중</h1><p id="status" role="status" aria-live="polite">캐릭터 목록을 확인하고 있어요.</p><p>잠시만 기다려 주세요.</p></html>`)}`)
    if (!win.isDestroyed()) win.showInactive()
  }
  progress(value: PackProgress) {
    this.message(value.phase === "rig" ? `캐릭터 동작 확인 중 · ${value.completed} / ${value.total}` : "캐릭터 파일을 확인하고 있어요.")
  }
  message(value: string) {
    const win = this.window
    if (win && !win.isDestroyed()) void win.webContents.executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(value)}`).catch(() => {})
  }
  close() { const win = this.window; this.window = null; if (win && !win.isDestroyed()) win.destroy() }
}
