const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // task data
  getData: () => ipcRenderer.invoke('get-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  getDataPath: () => ipcRenderer.invoke('get-data-path'),
  onDataChanged: (cb) => ipcRenderer.on('data-changed', (_e, data) => cb(data)),
  // sync folder
  chooseSyncFolder: () => ipcRenderer.invoke('choose-sync-folder'),
  setSyncFolder: (folder) => ipcRenderer.invoke('set-sync-folder', folder),
  // settings / window
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings, opts) => ipcRenderer.invoke('save-settings', settings, opts),
  pruneStreak: (streak) => ipcRenderer.invoke('prune-streak', streak),
  setMini: (on) => ipcRenderer.invoke('set-mini', on),
  onOpenView: (cb) => ipcRenderer.on('open-view', (_e, v) => cb(v)),
  setOpacity: (v) => ipcRenderer.invoke('set-opacity', v),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  // streak / notifications / badges
  getStreak: () => ipcRenderer.invoke('get-streak'),
  updateStreak: (data) => ipcRenderer.invoke('update-streak', data),
  onStreakChanged: (cb) => ipcRenderer.on('streak-changed', () => cb()),
  sendNotification: (opts) => ipcRenderer.invoke('send-notification', opts),
  setOverdue: (n, badgePng) => ipcRenderer.invoke('set-overdue', n, badgePng),
  // backup / restore
  backupData: () => ipcRenderer.invoke('backup-data'),
  restoreData: () => ipcRenderer.invoke('restore-data'),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  // quick-add popup
  quickAdd: (payload) => ipcRenderer.invoke('quick-add', payload),
  closeQuick: () => ipcRenderer.invoke('close-quick')
});
