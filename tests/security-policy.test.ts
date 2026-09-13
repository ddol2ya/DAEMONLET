import { describe, expect, it } from "vitest"
import type { BrowserWindow, WebContents } from "electron"
import { expectedRendererUrl, isTrustedProtocolSender, isTrustedSender } from "../electron/main/SecurityPolicy"

describe("Electron security policy", () => {
  it("uses exact role-specific dev and production URLs", () => {
    expect(expectedRendererUrl("pet")).toBe("pet://app/pet.html")
    expect(expectedRendererUrl("lab")).toBe("pet://app/index.html")
    expect(expectedRendererUrl("pet", "http://127.0.0.1:4173/")).toBe("http://127.0.0.1:4173/pet.html")
  })

  it("requires matching frame URL, webContents ID, and live window", () => {
    const frame = { url: "pet://app/pet.html" }
    const contents = { id: 7, mainFrame: frame } as WebContents
    const window = { isDestroyed: () => false, webContents: contents } as BrowserWindow
    expect(isTrustedSender({ sender: contents, senderFrame: frame }, window, "pet")).toBe(true)
    expect(isTrustedSender({ sender: contents, senderFrame: { url: "pet://app/pet.html" } }, window, "pet")).toBe(false)
    expect(isTrustedSender({ sender: { id: 8 } as WebContents, senderFrame: { url: "pet://app/pet.html" } }, window, "pet")).toBe(false)
    expect(isTrustedSender({ sender: contents, senderFrame: { url: "pet://other/pet.html" } }, window, "pet")).toBe(false)
    expect(isTrustedSender({ sender: contents, senderFrame: { url: "pet://app/pet.html" } }, null, "pet")).toBe(false)
  })

  it("accepts Pet and Lab only for the shared protocol boundary", () => {
    const petContents = { id: 7, mainFrame: { url: "pet://app/pet.html" } } as WebContents
    const labFrame = { url: "pet://app/index.html" }
    const labContents = { id: 8, mainFrame: labFrame } as WebContents
    const pet = { isDestroyed: () => false, webContents: petContents } as BrowserWindow
    const lab = { isDestroyed: () => false, webContents: labContents } as BrowserWindow
    const labEvent = { sender: labContents, senderFrame: labFrame }
    expect(isTrustedProtocolSender(labEvent, pet, lab)).toBe(true)
    expect(isTrustedSender(labEvent, pet, "pet")).toBe(false)
    expect(isTrustedProtocolSender({ sender: labContents, senderFrame: { url: "pet://app/pet.html" } }, pet, lab)).toBe(false)
  })

  it("isolates Settings, denies same-URL subframes, and never grants it the protocol transport", () => {
    const frame = { url: "pet://app/settings.html" }
    const contents = { id: 9, mainFrame: frame } as WebContents
    const settings = { isDestroyed: () => false, webContents: contents } as BrowserWindow
    expect(expectedRendererUrl("settings")).toBe("pet://app/settings.html")
    expect(expectedRendererUrl("settings", "http://127.0.0.1:4173/")).toBe("http://127.0.0.1:4173/settings.html")
    expect(isTrustedSender({ sender: contents, senderFrame: frame }, settings, "settings")).toBe(true)
    expect(isTrustedSender({ sender: contents, senderFrame: { ...frame } }, settings, "settings")).toBe(false)
    expect(isTrustedSender({ sender: contents, senderFrame: null }, settings, "settings")).toBe(false)
    expect(isTrustedSender({ sender: contents, senderFrame: frame }, settings, "pet")).toBe(false)
    expect(isTrustedProtocolSender({ sender: contents, senderFrame: frame }, null, null)).toBe(false)
    for (const suffix of ["?test=1", "#smoke", "/", "?url=pet://app/settings.html"]) {
      frame.url = `pet://app/settings.html${suffix}`
      expect(isTrustedSender({ sender: contents, senderFrame: frame }, settings, "settings")).toBe(false)
    }
  })
})
