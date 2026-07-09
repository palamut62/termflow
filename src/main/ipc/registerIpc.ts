import { ipcMain, dialog, BrowserWindow, safeStorage } from 'electron'
import pidusage from 'pidusage'
import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import {
  IPC,
  type CreateTerminalInput,
  type WorkspaceLayout,
  type TerminalSession,
  type RenderMode,
  type AppSettings,
  type ProcStats,
  type Snippet,
  type HighlightRule,
  type SshProfile,
  type EnvEntry,
  type WorkspaceExport,
  type GitStatus
} from '../../shared/types'
import { PtyManager, type RoutingRule, type RecordingEntry } from '../pty/PtyManager'
import { discoverShells } from '../pty/shells'
import * as dbApi from '../db/database'

export function registerIpc(getWindow: () => BrowserWindow | null): PtyManager {
  const pty = new PtyManager(() => {
    // A destroyed BrowserWindow throws on `.webContents` access, so guard the
    // window itself before touching webContents (fixes "Object has been
    // destroyed" when a PTY flushes during/after window close).
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const wc = win.webContents
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

  // ---- Window (titlebar overlay follows the app theme) ----
  ipcMain.on(IPC.WINDOW_OVERLAY, (_e, color: string, symbolColor: string) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      try {
        win.setTitleBarOverlay({ color, symbolColor, height: 44 })
      } catch {
        /* platform without overlay support */
      }
    }
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

  // ---- Snippets ----
  ipcMain.handle(IPC.SNIPPET_LIST, (_e, workspaceId?: string) => dbApi.listSnippets(workspaceId))
  ipcMain.handle(IPC.SNIPPET_CREATE, (_e, input: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>) => dbApi.createSnippet(input))
  ipcMain.handle(IPC.SNIPPET_UPDATE, (_e, id: string, patch: Partial<Snippet>) => dbApi.updateSnippet(id, patch))
  ipcMain.handle(IPC.SNIPPET_DELETE, (_e, id: string) => dbApi.deleteSnippet(id))

  // ---- Highlight Rules ----
  ipcMain.handle(IPC.HL_RULE_LIST, (_e, workspaceId?: string) => dbApi.listHighlightRules(workspaceId))
  ipcMain.handle(IPC.HL_RULE_CREATE, (_e, input: Omit<HighlightRule, 'id'>) => dbApi.createHighlightRule(input))
  ipcMain.handle(IPC.HL_RULE_UPDATE, (_e, id: string, patch: Partial<HighlightRule>) => dbApi.updateHighlightRule(id, patch))
  ipcMain.handle(IPC.HL_RULE_DELETE, (_e, id: string) => dbApi.deleteHighlightRule(id))

  // ---- SSH Profiles ----
  ipcMain.handle(IPC.SSH_PROFILE_LIST, (_e, workspaceId: string) => dbApi.listSshProfiles(workspaceId))
  ipcMain.handle(IPC.SSH_PROFILE_CREATE, (_e, input: Omit<SshProfile, 'id' | 'createdAt'>) => dbApi.createSshProfile(input))
  ipcMain.handle(IPC.SSH_PROFILE_UPDATE, (_e, id: string, patch: Partial<SshProfile>) => dbApi.updateSshProfile(id, patch))
  ipcMain.handle(IPC.SSH_PROFILE_DELETE, (_e, id: string) => dbApi.deleteSshProfile(id))

  // ---- Env Vars ----
  ipcMain.handle(IPC.ENV_LIST, (_e, workspaceId: string) => {
    const vars = dbApi.listEnvVars(workspaceId)
    // Return masked values (don't send secrets to renderer in plaintext)
    return vars.map((v) => ({ ...v, value: v.masked ? '••••••••' : v.value }))
  })
  ipcMain.handle(IPC.ENV_CREATE, (_e, input: { workspaceId: string; key: string; value: string; masked: boolean }) => {
    const encrypted = input.masked && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(input.value).toString('base64')
      : input.value
    return dbApi.createEnvVar({ workspaceId: input.workspaceId, key: input.key, value: encrypted, masked: input.masked && safeStorage.isEncryptionAvailable() })
  })
  ipcMain.handle(IPC.ENV_UPDATE, (_e, id: string, patch: Partial<EnvEntry>) => {
    if (patch.value && safeStorage.isEncryptionAvailable()) {
      const existing = dbApi.listEnvVars('').find((e) => e.id === id) || dbApi.listEnvVars(patch.workspaceId || '').find((e) => e.id === id)
      if (existing?.masked) patch.value = safeStorage.encryptString(patch.value).toString('base64')
    }
    dbApi.updateEnvVar(id, patch)
  })
  ipcMain.handle(IPC.ENV_DELETE, (_e, id: string) => dbApi.deleteEnvVar(id))

  // ---- Workspace Export/Import ----
  ipcMain.handle(IPC.WS_EXPORT, async (_e, workspaceId: string) => {
    const ws = dbApi.listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) return
    const data = dbApi.exportWorkspaceData(workspaceId)
    const exp: WorkspaceExport = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      workspace: { name: ws.name, description: ws.description, defaultLayoutMode: ws.defaultLayoutMode },
      nodes: data.nodes,
      connections: data.connections,
      viewport: data.viewport ?? { zoom: 1, x: 0, y: 0 },
      snippets: data.snippets
    }
    const win = getWindow()
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export Workspace',
      defaultPath: `${ws.name.replace(/\s+/g, '_')}.termflow.json`,
      filters: [{ name: 'TermFlow Workspace', extensions: ['termflow.json'] }]
    })
    if (!res.canceled && res.filePath) {
      writeFileSync(res.filePath, JSON.stringify(exp, null, 2), 'utf-8')
    }
  })

  ipcMain.handle(IPC.WS_IMPORT, async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: 'Import Workspace',
      filters: [{ name: 'TermFlow Workspace', extensions: ['termflow.json'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return null
    try {
      const raw = JSON.parse(readFileSync(res.filePaths[0], 'utf-8'))
      if (!raw.schemaVersion || !raw.workspace) throw new Error('Invalid format')

      // Generate new IDs via remap
      const idMap = new Map<string, string>()
      const remap = (oldId: string): string => {
        if (!idMap.has(oldId)) idMap.set(oldId, nanoid())
        return idMap.get(oldId)!
      }

      const newNodes = (raw.nodes || []).map((n: any) => {
        const newId = remap(n.id)
        const newTermId = remap(n.terminalId || (n.panes?.terminalId || ''))
        return { ...n, id: newId, terminalId: n.terminalId ? newTermId : undefined, workspaceId: '' }
      })
      const newConns = (raw.connections || []).map((c: any) => ({
        ...c, id: remap(c.id),
        sourceNodeId: remap(c.sourceNodeId),
        targetNodeId: remap(c.targetNodeId),
        workspaceId: ''
      }))

      const ws = dbApi.createWorkspace({
        name: raw.workspace.name || 'Imported',
        path: raw.workspace.path || process.env.USERPROFILE || '',
        description: raw.workspace.description,
        defaultLayoutMode: raw.workspace.defaultLayoutMode
      })

      const wsNodes = newNodes.map((n: any) => ({ ...n, workspaceId: ws.id }))
      const wsConns = newConns.map((c: any) => ({ ...c, workspaceId: ws.id }))
      const wsSnippets = (raw.snippets || []).map((s: any) => ({
        ...s, id: remap(s.id), workspaceId: ws.id, scope: 'workspace' as const
      }))

      dbApi.importWorkspaceData(ws.id, wsNodes, wsConns, wsSnippets, raw.viewport || { zoom: 1, x: 0, y: 0 })
      return ws.id
    } catch (err) {
      console.error('Import failed:', err)
      return null
    }
  })

  // ---- Project Manifest (.termflow.json) ----
  ipcMain.handle(IPC.WS_CHECK_MANIFEST, async (_e, cwd: string) => {
    const manifestPath = join(cwd, '.termflow.json')
    if (!existsSync(manifestPath)) return null
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.DIALOG_CHECK_FILE, async (_e, path: string) => existsSync(path))

  // ---- Git Status ----
  ipcMain.handle(IPC.GIT_STATUS, async (_e, cwd: string): Promise<GitStatus | null> => {
    try {
      const branch = execSync('git branch --show-current', { cwd, encoding: 'utf-8', timeout: 3000 }).trim()
      const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 3000 })
      return { branch, dirty: status.length > 0 }
    } catch {
      return null
    }
  })

  // ---- Agent Routing ----
  ipcMain.on(IPC.AGENT_SET_ROUTING, (_e, terminalId: string, rules: RoutingRule[]) => {
    pty.setRouting(terminalId, rules)
  })

  // ---- Recording ----
  ipcMain.on(IPC.REC_START, (_e, id: string) => pty.startRecording(id))
  ipcMain.handle(IPC.REC_STOP, (_e, id: string): RecordingEntry[] => pty.stopRecording(id))
  ipcMain.handle(IPC.REC_SAVE, async (_e, id: string) => {
    const chunks = pty.getRecording(id)
    if (!chunks.length) return
    // Convert to asciinema v2 format
    const header = { version: 2, width: 120, height: 30 }
    const lines = [JSON.stringify(header)]
    for (const c of chunks) {
      lines.push(JSON.stringify([c.ts / 1000, 'o', c.data]))
    }
    const win = getWindow()
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save Recording',
      defaultPath: `termflow-recording-${Date.now()}.cast`,
      filters: [{ name: 'Asciinema Cast', extensions: ['cast'] }]
    })
    if (!res.canceled && res.filePath) {
      writeFileSync(res.filePath, lines.join('\n') + '\n', 'utf-8')
    }
  })

  return pty
}
