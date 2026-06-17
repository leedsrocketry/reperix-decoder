import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  listSerialPorts: (): Promise<string[]> =>
    ipcRenderer.invoke('serial:list-ports'),

  connect: (port: string, baud: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('serial:connect', port, baud),

  disconnect: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('serial:disconnect'),

  onSerialData: (callback: (msg: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, msg: unknown) => callback(msg)
    ipcRenderer.on('serial:data', handler)
    return () => ipcRenderer.off('serial:data', handler)
  },

  getFrames: (limit = 500): Promise<Array<{ id: number; ts: string; raw_hex: string; rssi: number | null; snr: number | null }>> =>
    ipcRenderer.invoke('db:get-frames', limit),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
  } catch (error) {
    console.error(error)
  }
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
