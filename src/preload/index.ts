import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type CreateTerminalInput,
  type Workspace,
  type WorkspaceLayout,
  type TerminalSession,
  type LayoutMode,
  type RenderMode,
  type AppSettings,
  type ProcStats
} from '../shared/types'

const api = {
  // ---- PTY ----
  pty: {
    create: (id: string, input: CreateTerminalInput): Promise<{ pid: number }> =>
      ipcRenderer.invoke(IPC.PTY_CREATE, id, input),
    write: (id: string, data: string): void => ipcRenderer.send(IPC.PTY_WRITE, id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send(IPC.PTY_RESIZE, id, cols, rows),
    kill: (id: string): void => ipcRenderer.send(IPC.PTY_KILL, id),
    setMode: (id: string, mode: RenderMode): void => ipcRenderer.send(IPC.PTY_MODE, id, mode),
    restart: (id: string): Promise<{ pid: number } | null> => ipcRenderer.invoke(IPC.PTY_RESTART, id),
    buffer: (id: string): Promise<string> => ipcRenderer.invoke(IPC.PTY_BUFFER, id),
    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const h = (_e: unknown, payload: { id: string; data: string }): void => cb(payload.id, payload.data)
      ipcRenderer.on(IPC.PTY_DATA, h)
      return () => ipcRenderer.removeListener(IPC.PTY_DATA, h)
    },
    onExit: (cb: (id: string, exitCode: number) => void): (() => void) => {
      const h = (_e: unknown, payload: { id: string; exitCode: number }): void =>
        cb(payload.id, payload.exitCode)
      ipcRenderer.on(IPC.PTY_EXIT, h)
      return () => ipcRenderer.removeListener(IPC.PTY_EXIT, h)
    },
    onActivity: (cb: (id: string, error: boolean) => void): (() => void) => {
      const h = (_e: unknown, payload: { id: string; error: boolean }): void => cb(payload.id, payload.error)
      ipcRenderer.on(IPC.PTY_ACTIVITY, h)
      return () => ipcRenderer.removeListener(IPC.PTY_ACTIVITY, h)
    }
  },
  proc: {
    stats: (): Promise<Record<string, ProcStats>> => ipcRenderer.invoke(IPC.PROC_STATS)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_SET, patch)
  },
  window: {
    setOverlay: (color: string, symbolColor: string): void =>
      ipcRenderer.send(IPC.WINDOW_OVERLAY, color, symbolColor)
  },
  shells: {
    discover: () => ipcRenderer.invoke(IPC.SHELLS_DISCOVER)
  },
  dialog: {
    openDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.DIALOG_OPEN_DIR)
  },
  workspaces: {
    list: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC.WS_LIST),
    create: (input: {
      name: string
      path: string
      description?: string
      icon?: string
      defaultLayoutMode?: LayoutMode
    }): Promise<Workspace> => ipcRenderer.invoke(IPC.WS_CREATE, input),
    update: (id: string, patch: Partial<Workspace>): Promise<void> =>
      ipcRenderer.invoke(IPC.WS_UPDATE, id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.WS_DELETE, id)
  },
  terminals: {
    list: (workspaceId: string): Promise<TerminalSession[]> =>
      ipcRenderer.invoke(IPC.TERM_LIST, workspaceId),
    upsert: (t: TerminalSession): Promise<void> => ipcRenderer.invoke(IPC.TERM_UPSERT, t),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.TERM_DELETE, id)
  },
  layout: {
    get: (workspaceId: string): Promise<WorkspaceLayout> => ipcRenderer.invoke(IPC.LAYOUT_GET, workspaceId),
    save: (layout: WorkspaceLayout): Promise<void> => ipcRenderer.invoke(IPC.LAYOUT_SAVE, layout)
  }
}

contextBridge.exposeInMainWorld('termflow', api)

export type TermflowApi = typeof api
