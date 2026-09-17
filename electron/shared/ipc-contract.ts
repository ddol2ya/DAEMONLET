import type { ProtocolClientCommand } from "../../src/protocol/types"
import type { DesktopSettingsPatch, DesktopSettingsV1 } from "./desktop-settings"
import type { HookEventReceipt } from "../../adapter/codex/hooks/HookEvents"
import type { CharacterReadApi, CharacterSelection } from "./character-pack-contract"
import type { BubblePresentationApi } from "./bubble-presentation"
import type { WindowDragRequest, WindowDragReply } from "./window-drag"
import type { CharacterLoadDiagnostic } from "./character-load-diagnostics"

export const IPC = {
  settingsGet: "desktop.settings.get",
  settingsPatch: "desktop.settings.patch",
  layoutSet: "desktop.layout.set",
  resetPosition: "desktop.window.reset-position",
  windowDrag: "desktop.window.drag",
  dragCancelled: "desktop.window.drag-cancelled",
  mousePassthrough: "desktop.mouse-passthrough.set",
  interactionLock: "desktop.interaction-lock.set",
  petReady: "desktop.pet.ready",
  alphaFailure: "desktop.alpha.failure",
  adapterRestart: "desktop.adapter.restart",
  adapterDiagnostics: "desktop.adapter.diagnostics",
  petReload: "desktop.pet.reload",
  protocolConnect: "desktop.protocol.connect",
  protocolDisconnect: "desktop.protocol.disconnect",
  protocolSend: "desktop.protocol.send",
  settingsChanged: "desktop.settings.changed",
  adapterStatus: "desktop.adapter.status",
  layoutChanged: "desktop.layout.changed",
  pointerOutside: "desktop.pointer.outside",
  protocolMessage: "desktop.protocol.message",
  protocolStatus: "desktop.protocol.status",
} as const

export type AdapterStatus = {
  codexAvailable?: boolean
  state: "STOPPED" | "STARTING" | "READY" | "EXTERNAL_RUNNING" | "DEGRADED" | "ERROR"
  message: string | null
  restartCount: number
}

export type AdapterOwnership = "OWNED_UTILITY" | "EXTERNAL_PROCESS" | "NONE"

export type SanitizedAdapterDiagnostics = AdapterStatus & {
  hookEvents?: HookEventReceipt[]
  adapterOwnership: AdapterOwnership
  protocolEndpoint: string
  hookEndpoint: string
  activeRunCount: number
  activeTaskCount: number
  provisionalRecoveredRunCount: number
  protocolClientCount: number
  externalProbeFailures: number
  lastExternalProbeAt: number | null
  warnings: string[]
}

export type PetReadyInfo = { webgl: boolean; characterId: string; revision?: string; firstFrameAt: number }
export type ProtocolBridgeStatus = { state: "DISCONNECTED" | "CONNECTING" | "OPEN" | "CLOSED" | "ERROR"; reason?: string; manual?: boolean }
export type ProtocolConnectResult = { ok: true } | { ok: false; name: string; message: string }

export interface DesktopProtocolApi {
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(command: ProtocolClientCommand): void
  onMessage(listener: (raw: string) => void): () => void
  onStatus(listener: (status: ProtocolBridgeStatus) => void): () => void
}

export interface MotionLabDesktopApi {
  characters: CharacterReadApi
  platform: string
  protocol: DesktopProtocolApi
}

export interface PetDesktopApi {
  platform: string
  dragWindow(request: WindowDragRequest): Promise<WindowDragReply>
  onDragCancelled(listener: () => void): () => void
  bubble: BubblePresentationApi
  characters: CharacterReadApi
  reportCharacterLoadFailure(selection: CharacterSelection): void
  reportCharacterLoadDiagnostic(value: CharacterLoadDiagnostic): void
  getSettings(): Promise<DesktopSettingsV1>
  updateSettings(patch: DesktopSettingsPatch): Promise<DesktopSettingsV1>
  setLayoutMode(enabled: boolean): Promise<void>
  resetPosition(): Promise<void>
  setMousePassthrough(ignore: boolean): Promise<void>
  setInteractionLocked(locked: boolean): void
  reportReady(info: PetReadyInfo): void
  reportAlphaFailure(message: string): void
  restartAdapter(): Promise<void>
  getAdapterDiagnostics(): Promise<SanitizedAdapterDiagnostics>
  reloadPet(): Promise<void>
  onSettingsChanged(listener: (settings: DesktopSettingsV1) => void): () => void
  onAdapterStatus(listener: (status: AdapterStatus) => void): () => void
  onLayoutChanged(listener: (enabled: boolean) => void): () => void
  onPointerOutside(listener: () => void): () => void
  protocol: DesktopProtocolApi
}

declare global {
  interface Window {
    petDesktop?: PetDesktopApi
    motionLabDesktop?: MotionLabDesktopApi
  }
}
