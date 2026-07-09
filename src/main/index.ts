import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'

// Dev: project resources/. Packaged: extraResources under process.resourcesPath.
const APP_ICON = app.isPackaged
  ? join(process.resourcesPath, 'resources', 'icon.ico')
  : join(__dirname, '../../resources/icon.ico')
import { initDatabase } from './db/database'
import { registerIpc } from './ipc/registerIpc'
import type { PtyManager } from './pty/PtyManager'

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#111318',
    icon: APP_ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#20242c', symbolColor: '#a0a7b4', height: 44 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Show the window reliably. `ready-to-show` can fail to fire on some Windows
  // configurations (seen with titleBarOverlay), leaving the process running with
  // a hidden window — the app appears "not to open". Show on both events plus a
  // hard fallback timer, all idempotent.
  const reveal = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
  mainWindow.once('ready-to-show', reveal)
  mainWindow.webContents.once('did-finish-load', reveal)
  setTimeout(reveal, 3000)

  // Stop PTYs first, then drop the reference so nothing sends to a dead window.
  mainWindow.on('closed', () => {
    ptyManager?.killAll()
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Single-instance: focus the existing window instead of spawning a second
// process that would fight over the userData/cache locks.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  initDatabase()
  ptyManager = registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  ptyManager?.killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ptyManager?.killAll()
})
