const { contextBridge, ipcRenderer } = require('electron');

const api = {
  isElectron: true,
  readSource: input => ipcRenderer.invoke('read-source', input),
  llmChat: opts => ipcRenderer.invoke('llm-chat', opts),
  llmModels: opts => ipcRenderer.invoke('llm-models', opts),
  llmLoad: opts => ipcRenderer.invoke('llm-load', opts),
  ttsGenerate: opts => ipcRenderer.invoke('tts-generate', opts),
  vramTelemetry: baseURL => ipcRenderer.invoke('vram-telemetry', baseURL),
  openURL: url => ipcRenderer.invoke('open-url', url),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  setAlwaysOnTop: enabled => ipcRenderer.invoke('window-set-always-on-top', enabled),
  windowAlwaysOnTop: () => ipcRenderer.invoke('window-always-on-top'),
  moveWindow: target => ipcRenderer.invoke('move-window', target),
  windowLocation: () => ipcRenderer.invoke('window-location'),
};

contextBridge.exposeInMainWorld('gengo', api);
contextBridge.exposeInMainWorld('duet', api);
