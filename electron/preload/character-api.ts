import { ipcRenderer } from "electron"
import { CHARACTER_IPC, type CharacterReadApi, type CharacterManageApi } from "../shared/character-pack-contract"

async function request<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as { ok: true; value: T } | { ok: false; code: string }
  if (!result.ok) throw new Error(result.code)
  return result.value
}
export function characterReadApi(): CharacterReadApi {
  return Object.freeze({
    list: () => request(CHARACTER_IPC.list),
    select: selection => request(CHARACTER_IPC.select, selection),
    onChanged: listener => { const wrapped = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value); ipcRenderer.on(CHARACTER_IPC.changed, wrapped); return () => ipcRenderer.removeListener(CHARACTER_IPC.changed, wrapped) },
  } satisfies CharacterReadApi)
}
export function characterManageApi(): CharacterManageApi {
  return Object.freeze({ ...characterReadApi(),
    onProgress: listener => { const wrapped = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value); ipcRenderer.on(CHARACTER_IPC.progress, wrapped); return () => ipcRenderer.removeListener(CHARACTER_IPC.progress, wrapped) },
    chooseImport: id => request(CHARACTER_IPC.choose, id), commitImport: token => request(CHARACTER_IPC.commit, token), cancelImport: id => request(CHARACTER_IPC.cancel, id),
    remove: selection => request(CHARACTER_IPC.remove, selection), rollback: selection => request(CHARACTER_IPC.rollback, selection),
  } satisfies CharacterManageApi)
}
