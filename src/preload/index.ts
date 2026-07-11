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
  type ProcStats,
  type Snippet,
  type HighlightRule,
  type SshProfile,
  type EnvEntry,
  type GitStatus,
  type WorkspaceHealthCheck
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
    openDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.DIALOG_OPEN_DIR),
    checkFile: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.DIALOG_CHECK_FILE, path)
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
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.WS_DELETE, id),
    export: (workspaceId: string): Promise<void> => ipcRenderer.invoke(IPC.WS_EXPORT, workspaceId),
    import: (): Promise<{ id?: string; error?: string } | null> => ipcRenderer.invoke(IPC.WS_IMPORT),
    checkManifest: (cwd: string): Promise<unknown> => ipcRenderer.invoke(IPC.WS_CHECK_MANIFEST, cwd),
    health: (workspaceId: string): Promise<WorkspaceHealthCheck[]> => ipcRenderer.invoke(IPC.WS_HEALTH, workspaceId)
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
  },
  // ---- Snippets ----
  snippets: {
    list: (workspaceId?: string): Promise<Snippet[]> => ipcRenderer.invoke(IPC.SNIPPET_LIST, workspaceId),
    create: (input: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>): Promise<Snippet> =>
      ipcRenderer.invoke(IPC.SNIPPET_CREATE, input),
    update: (id: string, patch: Partial<Snippet>): Promise<void> =>
      ipcRenderer.invoke(IPC.SNIPPET_UPDATE, id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SNIPPET_DELETE, id)
  },
  // ---- Highlight Rules ----
  highlightRules: {
    list: (workspaceId?: string): Promise<HighlightRule[]> => ipcRenderer.invoke(IPC.HL_RULE_LIST, workspaceId),
    create: (input: Omit<HighlightRule, 'id'>): Promise<HighlightRule> => ipcRenderer.invoke(IPC.HL_RULE_CREATE, input),
    update: (id: string, patch: Partial<HighlightRule>): Promise<void> => ipcRenderer.invoke(IPC.HL_RULE_UPDATE, id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.HL_RULE_DELETE, id)
  },
  // ---- SSH Profiles ----
  sshProfiles: {
    list: (workspaceId: string): Promise<SshProfile[]> => ipcRenderer.invoke(IPC.SSH_PROFILE_LIST, workspaceId),
    create: (input: Omit<SshProfile, 'id' | 'createdAt'>): Promise<SshProfile> =>
      ipcRenderer.invoke(IPC.SSH_PROFILE_CREATE, input),
    update: (id: string, patch: Partial<SshProfile>): Promise<void> =>
      ipcRenderer.invoke(IPC.SSH_PROFILE_UPDATE, id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SSH_PROFILE_DELETE, id)
  },
  // ---- Env Vars ----
  envVars: {
    list: (workspaceId: string): Promise<EnvEntry[]> => ipcRenderer.invoke(IPC.ENV_LIST, workspaceId),
    create: (input: { workspaceId: string; key: string; value: string; masked: boolean }): Promise<EnvEntry> =>
      ipcRenderer.invoke(IPC.ENV_CREATE, input),
    update: (id: string, patch: Partial<EnvEntry>): Promise<void> => ipcRenderer.invoke(IPC.ENV_UPDATE, id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ENV_DELETE, id)
  },
  // ---- Git ----
  git: {
    status: (cwd: string): Promise<GitStatus | null> => ipcRenderer.invoke(IPC.GIT_STATUS, cwd)
  },
  // ---- Agent Routing ----
  agent: {
    setRouting: (terminalId: string, rules: unknown[]): void =>
      ipcRenderer.send(IPC.AGENT_SET_ROUTING, terminalId, rules),
    onRoute: (cb: (connectionId: string) => void): (() => void) => {
      const h = (_e: unknown, payload: { connectionId: string }): void => cb(payload.connectionId)
      ipcRenderer.on(IPC.PTY_ROUTE, h)
      return () => ipcRenderer.removeListener(IPC.PTY_ROUTE, h)
    }
  },
  // ---- Recording ----
  recording: {
    start: (id: string): void => ipcRenderer.send(IPC.REC_START, id),
    stop: (id: string): Promise<unknown[]> => ipcRenderer.invoke(IPC.REC_STOP, id),
    save: (id: string): Promise<void> => ipcRenderer.invoke(IPC.REC_SAVE, id),
    onLimit: (cb: (id: string, reason: 'duration' | 'size') => void): (() => void) => {
      const h = (_e: unknown, payload: { id: string; reason: 'duration' | 'size' }): void =>
        cb(payload.id, payload.reason)
      ipcRenderer.on(IPC.REC_LIMIT, h)
      return () => ipcRenderer.removeListener(IPC.REC_LIMIT, h)
    }
  },
  diagnostics: {
    export: (workspaceId: string): Promise<void> => ipcRenderer.invoke(IPC.DIAGNOSTICS_EXPORT, workspaceId)
  }
}

contextBridge.exposeInMainWorld('termflow', api)

export type TermflowApi = typeof api
