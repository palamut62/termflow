import { app, BrowserWindow, Menu, shell, Tray } from 'electron'
import { join } from 'path'

// Dev: project resources/. Packaged: extraResources under process.resourcesPath.
const APP_ICON = app.isPackaged
  ? join(process.resourcesPath, 'resources', 'icon.ico')
  : join(__dirname, '../../resources/icon.ico')
import { getSettings, initDatabase } from './db/database'
import { registerIpc } from './ipc/registerIpc'
import type { PtyManager } from './pty/PtyManager'

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let tray: Tray | null = null
let isQuitting = false

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  tray = new Tray(APP_ICON)
  tray.setToolTip('TermFlow')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open TermFlow', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit TermFlow', click: () => { isQuitting = true; app.quit() } }
  ]))
  tray.on('double-click', showMainWindow)
}

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

  mainWindow.on('close', (event) => {
    if (isQuitting || !getSettings().minimizeToTray) return
    event.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'https:' || url.protocol === 'http:') shell.openExternal(url.toString())
    } catch {
      // Invalid and non-web URLs stay blocked.
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (url !== current) event.preventDefault()
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
    showMainWindow()
  })
}

app.whenReady().then(() => {
  initDatabase()
  const settings = getSettings()
  app.setLoginItemSettings({ openAtLogin: settings.startAtLogin, path: process.execPath })
  ptyManager = registerIpc(() => mainWindow)
  createTray()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  ptyManager?.killAll()
})
