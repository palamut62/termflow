import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC, type AppSettings } from '../../../shared/types'
import * as dbApi from '../../db/database'
import { discoverShells } from '../../pty/shells'
import type { PtyBackend } from '../../pty/backend'

/** Settings, shell discovery, window chrome and the directory picker. */

export function registerAppShellIpc(
  getWindow: () => BrowserWindow | null,
  withBackend: (fn: (backend: PtyBackend) => void) => void
): void {
  // ---- Window (titlebar overlay follows the app theme) ----
  ipcMain.on(IPC.WINDOW_OVERLAY, (_e, color: string, symbolColor: string) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      try {
        // 43px: 1px shorter than the toolbar so its bottom border shows through.
        win.setTitleBarOverlay({ color, symbolColor, height: 43 })
      } catch {
        /* platform without overlay support */
      }
    }
  })

  // ---- Window focus (desktop notification click) ----
  ipcMain.on(IPC.WINDOW_FOCUS, () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })

  // ---- Shells ----
  ipcMain.handle(IPC.SHELLS_DISCOVER, () => discoverShells())

  // ---- Settings ----
  ipcMain.handle(IPC.SETTINGS_GET, () => dbApi.getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<AppSettings>) => {
    const next = dbApi.setSettings(patch)
    if (app.isPackaged && patch.startAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: next.startAtLogin, path: process.execPath })
    }
    withBackend((b) => {
      b.setScrollback(next.scrollback)
      b.setPassiveInterval(next.passiveThrottleMs)
    })
    return next
  })

  // ---- Dialog ----
  ipcMain.handle(IPC.DIALOG_OPEN_DIR, async () => {
    const res = await dialog.showOpenDialog(getWindow()!, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
}
