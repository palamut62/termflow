import { ipcMain, dialog, BrowserWindow, safeStorage } from 'electron'
import pidusage from 'pidusage'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
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
import * as v from './validate'

function workspaceEnv(workspaceId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of dbApi.listEnvVars(workspaceId)) {
    if (entry.masked && safeStorage.isEncryptionAvailable()) {
      try {
        out[entry.key] = safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
      } catch {
        continue
      }
    } else if (!entry.masked) {
      out[entry.key] = entry.value
    }
  }
  return out
}

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
  ipcMain.handle(IPC.PTY_CREATE, (_e, id: string, input: CreateTerminalInput) => {
    const vid = v.parseOrThrow(v.idSchema, id)
    const vinput = v.parseOrThrow(v.createTerminalInput, input)
    return pty.create(vid, { ...vinput, env: { ...workspaceEnv(vinput.workspaceId), ...(vinput.env || {}) } })
  })
  ipcMain.on(IPC.PTY_WRITE, (_e, id: string, data: string) => {
    if (!v.idSchema.safeParse(id).success || typeof data !== 'string') return
    pty.write(id, data)
  })
  ipcMain.on(IPC.PTY_RESIZE, (_e, id: string, cols: number, rows: number) => {
    if (!v.idSchema.safeParse(id).success || !v.posInt.safeParse(cols).success || !v.posInt.safeParse(rows).success) return
    pty.resize(id, cols, rows)
  })
  ipcMain.on(IPC.PTY_KILL, (_e, id: string) => {
    if (!v.idSchema.safeParse(id).success) return
    pty.kill(id)
  })
  ipcMain.on(IPC.PTY_MODE, (_e, id: string, mode: RenderMode) => {
    if (!v.idSchema.safeParse(id).success || !v.renderModeSchema.safeParse(mode).success) return
    pty.setMode(id, mode)
  })
  ipcMain.handle(IPC.PTY_RESTART, (_e, id: string) => pty.restart(v.parseOrThrow(v.idSchema, id)))
  ipcMain.handle(IPC.PTY_BUFFER, (_e, id: string) => pty.getBuffer(v.parseOrThrow(v.idSchema, id)))

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
    if (typeof color !== 'string' || typeof symbolColor !== 'string') return
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
    v.parseOrThrow(v.settingsPatch, patch)
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
  ipcMain.handle(IPC.WS_CREATE, (_e, input) => dbApi.createWorkspace(v.parseOrThrow(v.workspaceCreate, input)))
  ipcMain.handle(IPC.WS_UPDATE, (_e, id, patch) => dbApi.updateWorkspace(v.parseOrThrow(v.idSchema, id), v.parseOrThrow(v.workspacePatch, patch)))
  ipcMain.handle(IPC.WS_DELETE, (_e, id) => dbApi.deleteWorkspace(v.parseOrThrow(v.idSchema, id)))

  // ---- Terminals persistence ----
  ipcMain.handle(IPC.TERM_LIST, (_e, workspaceId: string) => dbApi.listTerminals(v.parseOrThrow(v.idSchema, workspaceId)))
  ipcMain.handle(IPC.TERM_UPSERT, (_e, t: TerminalSession) => dbApi.upsertTerminal(v.parseOrThrow(v.terminalSession, t) as TerminalSession))
  ipcMain.handle(IPC.TERM_DELETE, (_e, id: string) => dbApi.deleteTerminal(v.parseOrThrow(v.idSchema, id)))

  // ---- Layout ----
  ipcMain.handle(IPC.LAYOUT_GET, (_e, workspaceId: string) => dbApi.getLayout(v.parseOrThrow(v.idSchema, workspaceId)))
  ipcMain.handle(IPC.LAYOUT_SAVE, (_e, layout: WorkspaceLayout) => dbApi.saveLayout(v.parseOrThrow(v.workspaceLayout, layout) as WorkspaceLayout))

  // ---- Snippets ----
  ipcMain.handle(IPC.SNIPPET_LIST, (_e, workspaceId?: string) => dbApi.listSnippets(workspaceId == null ? undefined : v.parseOrThrow(v.idSchema, workspaceId)))
  ipcMain.handle(IPC.SNIPPET_CREATE, (_e, input: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>) => dbApi.createSnippet(v.parseOrThrow(v.snippetCreate, input) as Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>))
  ipcMain.handle(IPC.SNIPPET_UPDATE, (_e, id: string, patch: Partial<Snippet>) => dbApi.updateSnippet(v.parseOrThrow(v.idSchema, id), v.parseOrThrow(v.snippetPatch, patch)))
  ipcMain.handle(IPC.SNIPPET_DELETE, (_e, id: string) => dbApi.deleteSnippet(v.parseOrThrow(v.idSchema, id)))

  // ---- Highlight Rules ----
  ipcMain.handle(IPC.HL_RULE_LIST, (_e, workspaceId?: string) => dbApi.listHighlightRules(workspaceId == null ? undefined : v.parseOrThrow(v.idSchema, workspaceId)))
  ipcMain.handle(IPC.HL_RULE_CREATE, (_e, input: Omit<HighlightRule, 'id'>) => dbApi.createHighlightRule(v.parseOrThrow(v.highlightRuleCreate, input) as Omit<HighlightRule, 'id'>))
  ipcMain.handle(IPC.HL_RULE_UPDATE, (_e, id: string, patch: Partial<HighlightRule>) => dbApi.updateHighlightRule(v.parseOrThrow(v.idSchema, id), v.parseOrThrow(v.highlightRulePatch, patch)))
  ipcMain.handle(IPC.HL_RULE_DELETE, (_e, id: string) => dbApi.deleteHighlightRule(v.parseOrThrow(v.idSchema, id)))

  // ---- SSH Profiles ----
  ipcMain.handle(IPC.SSH_PROFILE_LIST, (_e, workspaceId: string) => dbApi.listSshProfiles(v.parseOrThrow(v.idSchema, workspaceId)))
  ipcMain.handle(IPC.SSH_PROFILE_CREATE, (_e, input: Omit<SshProfile, 'id' | 'createdAt'>) => dbApi.createSshProfile(v.parseOrThrow(v.sshProfileCreate, input) as Omit<SshProfile, 'id' | 'createdAt'>))
  ipcMain.handle(IPC.SSH_PROFILE_UPDATE, (_e, id: string, patch: Partial<SshProfile>) => dbApi.updateSshProfile(v.parseOrThrow(v.idSchema, id), v.parseOrThrow(v.sshProfilePatch, patch)))
  ipcMain.handle(IPC.SSH_PROFILE_DELETE, (_e, id: string) => dbApi.deleteSshProfile(v.parseOrThrow(v.idSchema, id)))

  // ---- Env Vars ----
  ipcMain.handle(IPC.ENV_LIST, (_e, workspaceId: string) => {
    v.parseOrThrow(v.idSchema, workspaceId)
    const vars = dbApi.listEnvVars(workspaceId)
    // Return masked values (don't send secrets to renderer in plaintext)
    return vars.map((v) => ({ ...v, value: v.masked ? '••••••••' : v.value }))
  })
  ipcMain.handle(IPC.ENV_CREATE, (_e, input: { workspaceId: string; key: string; value: string; masked: boolean }) => {
    const vin = v.parseOrThrow(v.envCreate, input)
    const encrypted = vin.masked && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(vin.value).toString('base64')
      : vin.value
    return dbApi.createEnvVar({ workspaceId: vin.workspaceId, key: vin.key, value: encrypted, masked: vin.masked && safeStorage.isEncryptionAvailable() })
  })
  ipcMain.handle(IPC.ENV_UPDATE, (_e, id: string, patch: Partial<EnvEntry>) => {
    v.parseOrThrow(v.idSchema, id)
    const vpatch = v.parseOrThrow(v.envPatch, patch) as Partial<EnvEntry>
    if (vpatch.value && safeStorage.isEncryptionAvailable()) {
      // Look up the record directly by id (empty workspaceId never matched — bug fix).
      const existing = dbApi.getEnvVar(id)
      if (existing?.masked) vpatch.value = safeStorage.encryptString(vpatch.value).toString('base64')
    }
    dbApi.updateEnvVar(id, vpatch)
  })
  ipcMain.handle(IPC.ENV_DELETE, (_e, id: string) => dbApi.deleteEnvVar(v.parseOrThrow(v.idSchema, id)))

  // ---- Workspace Export/Import ----
  ipcMain.handle(IPC.WS_EXPORT, async (_e, workspaceId: string) => {
    v.parseOrThrow(v.idSchema, workspaceId)
    const ws = dbApi.listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) return
    const data = dbApi.exportWorkspaceData(workspaceId)
    const exp: WorkspaceExport = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        name: ws.name,
        path: ws.path,
        description: ws.description,
        defaultLayoutMode: ws.defaultLayoutMode
      },
      nodes: data.nodes,
      terminals: data.terminals,
      connections: data.connections,
      viewport: data.viewport ?? { zoom: 1, x: 0, y: 0 },
      snippets: data.snippets,
      highlightRules: data.highlightRules,
      sshProfiles: data.sshProfiles,
      envVars: data.envVars
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
      const parsed = v.workspaceExport.safeParse(JSON.parse(readFileSync(res.filePaths[0], 'utf-8')))
      if (!parsed.success) return null
      const raw = parsed.data

      // Generate new IDs via remap
      const idMap = new Map<string, string>()
      const remap = (oldId: string): string => {
        if (!idMap.has(oldId)) idMap.set(oldId, nanoid())
        return idMap.get(oldId)!
      }

      const newTerms = (raw.terminals || []).map((t: any) => ({
        ...t,
        id: remap(t.id),
        workspaceId: '',
        pid: undefined,
        status: 'stopped'
      }))

      const newNodes = (raw.nodes || []).map((n: any) => {
        const newId = remap(n.id)
        const newTermId = n.terminalId ? remap(n.terminalId) : undefined
        return {
          ...n,
          id: newId,
          terminalId: newTermId,
          panes: dbApi.remapPaneIds(n.panes, remap),
          activePaneId: n.activePaneId ? remap(n.activePaneId) : undefined,
          workspaceId: ''
        }
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
      const wsTerms = newTerms.map((t: any) => ({ ...t, workspaceId: ws.id }))
      const wsConns = newConns.map((c: any) => ({ ...c, workspaceId: ws.id }))
      const wsSnippets = (raw.snippets || []).map((s: any) => ({
        ...s, id: remap(s.id), workspaceId: ws.id, scope: 'workspace' as const
      }))
      const wsHighlightRules = (raw.highlightRules || []).map((r: any) => ({
        ...r, id: remap(r.id), workspaceId: ws.id
      }))
      const wsSshProfiles = (raw.sshProfiles || []).map((p: any) => ({
        ...p, id: remap(p.id), workspaceId: ws.id
      }))
      const wsEnvVars = (raw.envVars || []).map((v: any) => ({
        ...v, id: remap(v.id), workspaceId: ws.id
      }))

      dbApi.importWorkspaceData(
        ws.id,
        wsTerms,
        wsNodes,
        wsConns,
        wsSnippets,
        wsHighlightRules,
        wsSshProfiles,
        wsEnvVars,
        raw.viewport || { zoom: 1, x: 0, y: 0 }
      )
      return ws.id
    } catch (err) {
      console.error('Import failed:', err)
      return null
    }
  })

  // ---- Project Manifest (.termflow.json) ----
  ipcMain.handle(IPC.WS_CHECK_MANIFEST, async (_e, cwd: string) => {
    if (!v.absolutePath.safeParse(cwd).success) return null
    const manifestPath = join(cwd, '.termflow.json')
    if (!existsSync(manifestPath)) return null
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.DIALOG_CHECK_FILE, async (_e, path: string) => {
    if (!v.absolutePath.safeParse(path).success) return false
    return existsSync(path)
  })

  // ---- Git Status ----
  ipcMain.handle(IPC.GIT_STATUS, async (_e, cwd: string): Promise<GitStatus | null> => {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !existsSync(cwd)) return null
    try {
      const branch = execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf-8', timeout: 3000 }).trim()
      const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf-8', timeout: 3000 })
      return { branch, dirty: status.length > 0 }
    } catch {
      return null
    }
  })

  // ---- Agent Routing ----
  ipcMain.on(IPC.AGENT_SET_ROUTING, (_e, terminalId: string, rules: RoutingRule[]) => {
    if (!v.idSchema.safeParse(terminalId).success || !Array.isArray(rules)) return
    pty.setRouting(terminalId, rules)
  })

  // ---- Recording ----
  ipcMain.on(IPC.REC_START, (_e, id: string) => {
    if (!v.idSchema.safeParse(id).success) return
    pty.startRecording(id)
  })
  ipcMain.handle(IPC.REC_STOP, (_e, id: string): RecordingEntry[] => pty.stopRecording(v.parseOrThrow(v.idSchema, id)))
  ipcMain.handle(IPC.REC_SAVE, async (_e, id: string) => {
    v.parseOrThrow(v.idSchema, id)
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
