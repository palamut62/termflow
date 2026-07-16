import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

export function initUpdater(): void {
  if (!app.isPackaged) return

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('autoUpdater error:', err)
    })
  }, 10000)
}
