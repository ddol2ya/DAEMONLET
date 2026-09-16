import { applicationInputAllowed } from "./updates/OperationGate"
import type { BrowserWindow, Session, WebContents } from "electron"

export type WindowRole = "pet" | "lab" | "settings" | "activity" | "activity-bubble" | "speech-bubble"

export function expectedRendererUrl(role: WindowRole, devServerUrl?: string): string {
  const page = { pet: "pet.html", lab: "index.html", settings: "settings.html", activity: "activity.html", "activity-bubble": "activity-bubble.html", "speech-bubble": "speech-bubble.html" }[role]
  return devServerUrl ? `${devServerUrl.replace(/\/$/, "")}/${page}` : `pet://app/${page}`
}

export function secureWebContents(contents: WebContents, role: WindowRole, devServerUrl?: string): void {
  const expected = expectedRendererUrl(role, devServerUrl)
  contents.on("will-navigate", (event, url) => { if (url !== expected) event.preventDefault() })
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
  contents.on("will-attach-webview", (event) => event.preventDefault())
}

export function denyAllPermissions(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}

export function isTrustedSender(
  event: { sender: WebContents; senderFrame: { url: string } | null },
  window: BrowserWindow | null,
  role: WindowRole,
  devServerUrl?: string,
  duringShutdown = false,
): boolean {
  if (!duringShutdown && !applicationInputAllowed()) return false
  return Boolean(window && !window.isDestroyed() && event.sender.id === window.webContents.id && event.senderFrame
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === expectedRendererUrl(role, devServerUrl))
}

export function isTrustedProtocolSender(
  event: { sender: WebContents; senderFrame: { url: string } | null },
  petWindow: BrowserWindow | null,
  labWindow: BrowserWindow | null,
  devServerUrl?: string,
): boolean {
  return isTrustedSender(event, petWindow, "pet", devServerUrl) || isTrustedSender(event, labWindow, "lab", devServerUrl)
}
