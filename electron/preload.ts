import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('cockpitNative', {
  pickFiles: () => ipcRenderer.invoke('cockpit:pick-files'),
  pickDirectory: () => ipcRenderer.invoke('cockpit:pick-directory'),
})
