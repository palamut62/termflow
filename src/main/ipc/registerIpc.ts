import { ipcMain, dialog, BrowserWindow } from 'electron'
import pidusage from 'pidusage'
import {
  IPC,
  type CreateTerminalInput,
  type WorkspaceLayout,
  type TerminalSession,
  type RenderMode,
  type AppSettings,
  type ProcStats
} from '../../shared/types'
import { PtyManager } from '../pty/PtyManager'
import { discoverShells } from '../pty/shells'
import * as dbApi from '../db/database'

export function registerIpc(getWindow: () => BrowserWindow | null): PtyManager {
  const pty = new PtyManager(() => {
    const wc = getWindow()?.webContents
    return wc && !wc.isDestroyed() ? wc : null
  })

  // Apply persisted performance settings.
  const s = dbApi.getSettings()
  pty.setScrollback(s.scrollback)
  pty.setPassiveInterval(s.passiveThrottleMs)

  // ---- PTY ----
  ipcMain.handle(IPC.PTY_CREATE, (_e, id: string, input: CreateTerminalInput) => pty.create(id, input))
  ipcMain.on(IPC.PTY_WRITE, (_e, id: string, data: string) => pty.write(id, data))
  ipcMain.on(IPC.PTY_RESIZE, (_e, id: string, cols: number, rows: number) => pty.resize(id, cols, rows))
  ipcMain.on(IPC.PTY_KILL, (_e, id: string) => pty.kill(id))
  ipcMain.on(IPC.PTY_MODE, (_e, id: string, mode: RenderMode) => pty.setMode(id, mode))
  ipcMain.handle(IPC.PTY_RESTART, (_e, id: string) => pty.restart(id))
  ipcMain.handle(IPC.PTY_BUFFER, (_e, id: string) => pty.getBuffer(id))

  // ---- Process stats (pidusage) — PRD §33.2 CPU/RAM ----
  ipcMain.handle(IPC.PROC_STATS, async (): Promise<Record<string, ProcStats>> => {
    const list = pty.pids()
    if (list.length === 0) return {}
    const out: Record<string, ProcStats> = {}
    await Promise.all(
      list.map(async ({ id, pid }) => {
        try {
          const st = await pidusage(pid)
          out[id] = { cpu: Math.round(st.cpu), memory: Math.round(st.memory / 1024 / 1024) }
        } catch {
          /* process gone */
        }
      })
    )
    return out
  })

  // ---- Shells ----
  ipcMain.handle(IPC.SHELLS_DISCOVER, () => discoverShells())

  // ---- Settings ----
  ipcMain.handle(IPC.SETTINGS_GET, () => dbApi.getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<AppSettings>) => {
    const next = dbApi.setSettings(patch)
    pty.setScrollback(next.scrollback)
    pty.setPassiveInterval(next.passiveThrottleMs)
    return next
  })

  // ---- Dialog ----
  ipcMain.handle(IPC.DIALOG_OPEN_DIR, async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // ---- Workspaces ----
  ipcMain.handle(IPC.WS_LIST, () => dbApi.listWorkspaces())
  ipcMain.handle(IPC.WS_CREATE, (_e, input) => dbApi.createWorkspace(input))
  ipcMain.handle(IPC.WS_UPDATE, (_e, id, patch) => dbApi.updateWorkspace(id, patch))
  ipcMain.handle(IPC.WS_DELETE, (_e, id) => dbApi.deleteWorkspace(id))

  // ---- Terminals persistence ----
  ipcMain.handle(IPC.TERM_LIST, (_e, workspaceId: string) => dbApi.listTerminals(workspaceId))
  ipcMain.handle(IPC.TERM_UPSERT, (_e, t: TerminalSession) => dbApi.upsertTerminal(t))
  ipcMain.handle(IPC.TERM_DELETE, (_e, id: string) => dbApi.deleteTerminal(id))

  // ---- Layout ----
  ipcMain.handle(IPC.LAYOUT_GET, (_e, workspaceId: string) => dbApi.getLayout(workspaceId))
  ipcMain.handle(IPC.LAYOUT_SAVE, (_e, layout: WorkspaceLayout) => dbApi.saveLayout(layout))

  return pty
}
