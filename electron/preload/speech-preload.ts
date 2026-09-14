import { exposeAppLanguage } from "./app-language"
exposeAppLanguage()
import { contextBridge, ipcRenderer } from "electron"
import { BUBBLE_IPC, type SpeechBubbleFrame } from "../shared/bubble-presentation"

// Receive-only. This window cannot change settings, input policy or task state.
contextBridge.exposeInMainWorld("petSpeech", Object.freeze({
  subscribe(listener: (frame: SpeechBubbleFrame | null) => void) {
    const receive = (_event: Electron.IpcRendererEvent, frame: SpeechBubbleFrame | null) => listener(frame)
    ipcRenderer.on(BUBBLE_IPC.speech, receive)
    return () => ipcRenderer.removeListener(BUBBLE_IPC.speech, receive)
  },
}))
