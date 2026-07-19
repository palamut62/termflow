import { app, ipcMain, dialog, BrowserWindow, safeStorage, net } from 'electron'
import { createHash } from 'crypto'
import pidusage from 'pidusage'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, statSync } from 'fs'
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { homedir } from 'os'
import { nanoid } from 'nanoid'

const execFileAsync = promisify(execFile)

// Kısa süreli cache: aynı cwd için ardışık git:status çağrılarında gereksiz process spawn'ı önler.
const GIT_STATUS_CACHE_TTL_MS = 1500
const GIT_STATUS_CACHE_MAX = 100
const gitStatusCache = new Map<string, { result: GitStatus | null; timestamp: number }>()
function setGitStatusCache(cwd: string, entry: { result: GitStatus | null; timestamp: number }): void {
  gitStatusCache.set(cwd, entry)
  // Bounded LRU: evict the oldest (first-inserted) entries beyond the cap.
  while (gitStatusCache.size > GIT_STATUS_CACHE_MAX) {
    const oldest = gitStatusCache.keys().next().value
    if (oldest === undefined) break
    gitStatusCache.delete(oldest)
  }
}
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
  type GitStatus,
  type WorkspaceHealthCheck
  ,type WorkspaceFileEntry
  ,type GitWorkbenchState
  ,type CredentialMeta
  ,type TermFlowPluginManifest
  ,type CreateAgentTeamInput
  ,type AgentTeam
  ,type TeamMember
  ,type TeamTask
} from '../../shared/types'
import { PtyManager, type RoutingRule, type RecordingEntry } from '../pty/PtyManager'
import { discoverShells } from '../pty/shells'
import * as dbApi from '../db/database'
import { validateManifest, validateWorkspaceExport } from '../../shared/validation'
import { validatePluginManifest } from '../../shared/pluginValidation'
import { PluginRuntime } from '../plugins/PluginRuntime'
import { TeamRuntime, type RuntimeCallbacks } from '../teams/TeamRuntime'
import { NativeTeamRuntime } from '../teams/NativeTeamRuntime'
import type { NativeTeamState } from '../teams/NativeBridge'

const MAX_JSON_FILE_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_BYTES = 512 * 1024

interface StoredCredential extends CredentialMeta { encryptedValue: string }
function vaultFile(): string { return join(app.getPath('userData'), 'credential-vault.json') }
async function readVault(): Promise<StoredCredential[]> { try { return JSON.parse(await readFile(vaultFile(), 'utf-8')) as StoredCredential[] } catch { return [] } }
async function writeVault(items: StoredCredential[]): Promise<void> { await writeFile(vaultFile(), JSON.stringify(items, null, 2), 'utf-8') }

function pathInside(root: string, candidate: string): string {
  const base = resolve(root)
  const target = resolve(candidate)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path is outside the workspace')
  return target
}

// Single gate for cwd coming from the renderer into filesystem/git IPC. A
// terminal's cwd can legitimately drift outside any known workspace (OSC 7
// tracks `cd`), so we only enforce that it is an absolute, existing directory
// — rejecting empty/non-string/relative/missing inputs. Kept as one place so
// the policy can be tightened later.
function validateCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string' || !cwd.trim() || !isAbsolute(cwd)) return null
  try {
    return statSync(cwd).isDirectory() ? cwd : null
  } catch {
    return null
  }
}

const PROVIDER_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'OPENAI_', 'OPENROUTER_', 'DEEPSEEK_', 'OLLAMA_']
const isProviderEnvKey = (key: string): boolean =>
  PROVIDER_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))

async function workspaceEnv(workspaceId: string, cleanProviderEnv = false): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of dbApi.listEnvVars(workspaceId)) {
    if (cleanProviderEnv && isProviderEnvKey(entry.key)) continue
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
  if (safeStorage.isEncryptionAvailable()) for (const credential of await readVault()) {
    if (credential.workspaceId && credential.workspaceId !== workspaceId) continue
    if (cleanProviderEnv && isProviderEnvKey(credential.envKey)) continue
    try { out[credential.envKey] = safeStorage.decryptString(Buffer.from(credential.encryptedValue, 'base64')) } catch { /* ignore invalid credential */ }
  }
  return out
}

export function registerIpc(getWindow: () => BrowserWindow | null): PtyManager {
  const pluginRuntime = new PluginRuntime()
  const pty = new PtyManager(() => {
    // A destroyed BrowserWindow throws on `.webContents` access, so guard the
    // window itself before touching webContents (fixes "Object has been
    // destroyed" when a PTY flushes during/after window close).
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const wc = win.webContents
    return wc && !wc.isDestroyed() ? wc : null
  })
  // Push the latest team bundle to the renderer for live canvas animation
  // (avoids relying on the 1s modal polling). Safe against a destroyed window.
  const pushTeam = (teamId: string): void => {
    const bundle = dbApi.getAgentTeam(teamId)
    if (!bundle) return
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (wc && !wc.isDestroyed()) wc.send(IPC.TEAM_EVENT, { teamId, bundle })
  }
  const teamCallbacks: RuntimeCallbacks = {
    getTeam: (id) => dbApi.getAgentTeam(id),
    workspacePath: (workspaceId) => dbApi.listWorkspaces().find((workspace) => workspace.id === workspaceId)?.path,
    runtimeRoot: () => app.getPath('userData'),
    updateTeam: (id, patch) => { dbApi.updateAgentTeam(id, patch); pushTeam(id) },
    updateMember: (id, patch) => { dbApi.updateTeamMember(id, patch); const team = dbApi.getTeamMember(id)?.teamId; if (team) pushTeam(team) },
    updateTask: (id, patch) => { dbApi.updateTeamTask(id, patch); const team = dbApi.getTeamTask(id)?.teamId; if (team) pushTeam(team) },
    event: (input) => { dbApi.appendTeamEvent(input); pushTeam(input.teamId) },
    syncNativeState: (teamId, state) => { dbApi.syncNativeTeamState(teamId, state as NativeTeamState); pushTeam(teamId) }
  }
  const teamRuntime = new TeamRuntime(teamCallbacks)
  const nativeRuntime = new NativeTeamRuntime(teamCallbacks)
  // Native teams cannot survive an app restart (their CLI child died with the
  // previous process): mark any lingering 'running' native team as lost.
  for (const workspace of dbApi.listWorkspaces()) {
    for (const bundle of dbApi.listAgentTeams(workspace.id)) {
      if (bundle.team.runtimeType === 'native' && bundle.team.status === 'running') nativeRuntime.reattachCheck(bundle.team.id)
    }
  }
  const runtimeFor = (id: string): TeamRuntime | NativeTeamRuntime => dbApi.getAgentTeam(id)?.team.runtimeType === 'native' ? nativeRuntime : teamRuntime
  app.once('before-quit', () => { teamRuntime.dispose(); nativeRuntime.dispose() })

  // Apply persisted performance settings.
  const s = dbApi.getSettings()
  pty.setScrollback(s.scrollback)
  pty.setPassiveInterval(s.passiveThrottleMs)

  // ---- PTY ----
  ipcMain.handle(IPC.PTY_CREATE, async (_e, id: string, input: CreateTerminalInput) =>
    pty.create(id, { ...input, env: { ...(await workspaceEnv(input.workspaceId, input.cleanProviderEnv)), ...(input.env || {}) } })
  )
  ipcMain.on(IPC.PTY_WRITE, (_e, id: string, data: string) => pty.write(id, data))
  ipcMain.on(IPC.PTY_RESIZE, (_e, id: string, cols: number, rows: number) => pty.resize(id, cols, rows))
  ipcMain.on(IPC.PTY_KILL, (_e, id: string) => pty.kill(id))
  ipcMain.on(IPC.PTY_MODE, (_e, id: string, mode: RenderMode) => pty.setMode(id, mode))
  ipcMain.handle(IPC.PTY_RESTART, (_e, id: string) => pty.restart(id))
  ipcMain.handle(IPC.PTY_BUFFER, (_e, id: string) => pty.getBuffer(id))
  ipcMain.handle(IPC.PTY_BUFFER_INFO, (_e, id: string) => pty.getBufferInfo(id))

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
    pty.setScrollback(next.scrollback)
    pty.setPassiveInterval(next.passiveThrottleMs)
    return next
  })

  // ---- Claude Code agent config files (settings.json / .claude.json) ----
  const agentCfgPath = (target: 'settings' | 'config'): string =>
    target === 'settings'
      ? join(homedir(), '.claude', 'settings.json')
      : join(homedir(), '.claude.json')
  ipcMain.handle(IPC.AGENT_CFG_READ, async (_e, target: 'settings' | 'config') => {
    const file = agentCfgPath(target === 'settings' ? 'settings' : 'config')
    try {
      const raw = await readFile(file, 'utf-8')
      const parsed = JSON.parse(raw)
      return (parsed && typeof parsed === 'object') ? parsed : {}
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return {}
      throw new Error(`Failed to read ${target}: ${e.message}`)
    }
  })
  ipcMain.handle(IPC.AGENT_CFG_WRITE, async (_e, target: 'settings' | 'config', patch: Record<string, unknown>) => {
    const t: 'settings' | 'config' = target === 'settings' ? 'settings' : 'config'
    const file = agentCfgPath(t)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Invalid patch')
    }
    // Always re-read the latest content before merging (handles large/concurrently-changed files).
    let current: Record<string, unknown> = {}
    try {
      const raw = await readFile(file, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
      // Backup existing file before overwriting.
      await writeFile(`${file}.termflow-bak`, raw, 'utf-8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw new Error(`Failed to read ${t} before write: ${e.message}`)
    }
    const merged = { ...current, ...patch }
    if (t === 'settings') await mkdir(join(homedir(), '.claude'), { recursive: true })
    await writeFile(file, JSON.stringify(merged, null, 2), 'utf-8')
    return merged
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

  // ---- Agent Teams ----
  ipcMain.handle(IPC.TEAM_LIST, (_e, workspaceId: string) => dbApi.listAgentTeams(workspaceId))
  ipcMain.handle(IPC.TEAM_CREATE, (_e, input: CreateAgentTeamInput) => dbApi.createAgentTeam(input))
  ipcMain.handle(IPC.TEAM_UPDATE, (_e, id: string, patch: Partial<Pick<AgentTeam, 'status' | 'name'>>) => {
    if (patch.status === 'paused') {
      if (dbApi.getAgentTeam(id)?.team.runtimeType === 'native') throw new Error('Pause is not supported for native teams.')
      teamRuntime.pause(id)
      return dbApi.getAgentTeam(id)
    }
    return dbApi.updateAgentTeam(id, patch)
  })
  ipcMain.handle(IPC.TEAM_MEMBER_UPDATE, (_e, id: string, patch: Partial<Pick<TeamMember, 'status' | 'terminalId' | 'sessionId' | 'provider'>>) => dbApi.updateTeamMember(id, patch))
  ipcMain.handle(IPC.TEAM_TASK_UPDATE, (_e, id: string, patch: Partial<Pick<TeamTask, 'status' | 'result' | 'assigneeId' | 'approved'>>) => dbApi.updateTeamTask(id, patch))
  ipcMain.handle(IPC.TEAM_DELETE, (_e, id: string) => dbApi.deleteAgentTeam(id))
  ipcMain.handle(IPC.TEAM_START, (_e, id: string) => runtimeFor(id).start(id))
  ipcMain.handle(IPC.TEAM_STOP, (_e, id: string) => runtimeFor(id).stop(id))
  ipcMain.handle(IPC.TEAM_APPLY, (_e, id: string) => {
    if (dbApi.getAgentTeam(id)?.team.runtimeType === 'native') throw new Error('Apply is not supported for native teams.')
    return teamRuntime.apply(id)
  })
  ipcMain.handle(IPC.TEAM_MESSAGE, (_e, id: string, text: string) => nativeRuntime.sendMessage(id, text))

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
      const existing = dbApi.getEnvVar(id)
      if (existing?.masked) patch.value = safeStorage.encryptString(patch.value).toString('base64')
    }
    dbApi.updateEnvVar(id, patch)
  })
  ipcMain.handle(IPC.ENV_DELETE, (_e, id: string) => dbApi.deleteEnvVar(id))

  ipcMain.handle(IPC.VAULT_LIST, async (_e, workspaceId?: string): Promise<CredentialMeta[]> => (await readVault()).filter((item) => !workspaceId || !item.workspaceId || item.workspaceId === workspaceId).map(({ encryptedValue: _secret, ...meta }) => meta))
  ipcMain.handle(IPC.VAULT_SAVE, async (_e, input: Omit<CredentialMeta, 'id' | 'updatedAt'> & { id?: string; value: string }): Promise<CredentialMeta> => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable')
    if (!input.name.trim() || !/^[A-Z_][A-Z0-9_]*$/i.test(input.envKey) || !input.value) throw new Error('Credential input is invalid')
    const items = await readVault()
    const id = input.id || nanoid()
    const record: StoredCredential = { id, name: input.name.trim(), provider: input.provider.trim(), envKey: input.envKey.trim(), workspaceId: input.workspaceId, updatedAt: new Date().toISOString(), encryptedValue: safeStorage.encryptString(input.value).toString('base64') }
    await writeVault([...items.filter((item) => item.id !== id), record])
    const { encryptedValue: _secret, ...meta } = record
    return meta
  })
  ipcMain.handle(IPC.VAULT_DELETE, async (_e, id: string) => writeVault((await readVault()).filter((item) => item.id !== id)))

  const pluginsDir = join(app.getPath('userData'), 'plugins')
  const pluginStateFile = join(app.getPath('userData'), 'plugin-state.json')
  const ensurePlugins = async (): Promise<void> => { await mkdir(pluginsDir, { recursive: true }) }
  const readDisabledPlugins = async (): Promise<Set<string>> => {
    try {
      const value = JSON.parse(await readFile(pluginStateFile, 'utf-8')) as { disabled?: unknown }
      return new Set(Array.isArray(value.disabled) ? value.disabled.filter((id): id is string => typeof id === 'string') : [])
    } catch { return new Set() }
  }
  const writeDisabledPlugins = async (disabled: Set<string>): Promise<void> => {
    await writeFile(pluginStateFile, JSON.stringify({ disabled: [...disabled].sort() }, null, 2), 'utf-8')
  }
  const installPluginBundle = async (raw: string, expectedHash?: string): Promise<TermFlowPluginManifest> => {
    if (Buffer.byteLength(raw) > MAX_JSON_FILE_BYTES) throw new Error('Plugin package is too large')
    const parsed = JSON.parse(raw) as { format?: string; formatVersion?: number; manifest?: unknown; files?: Record<string, string>; sha256?: string }
    if (parsed.format !== 'termflow-plugin-bundle' || parsed.formatVersion !== 1 || !parsed.manifest || !parsed.files) throw new Error('Invalid TermFlow plugin package')
    const unsigned = JSON.stringify({ format: parsed.format, formatVersion: parsed.formatVersion, manifest: parsed.manifest, files: parsed.files })
    const hash = createHash('sha256').update(unsigned).digest('hex')
    if (hash !== parsed.sha256 || (expectedHash && hash !== expectedHash)) throw new Error('Plugin package integrity check failed')
    const plugin = validatePluginManifest(parsed.manifest)
    const targetDir = join(pluginsDir, plugin.id)
    await mkdir(targetDir, { recursive: true })
    for (const [name, content] of Object.entries(parsed.files)) {
      if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.includes('..') || isAbsolute(name)) throw new Error('Plugin package contains an unsafe path')
      const target = join(targetDir, name)
      await mkdir(resolve(target, '..'), { recursive: true })
      await writeFile(target, Buffer.from(content, 'base64'))
    }
    await writeFile(join(targetDir, 'termflow-plugin.json'), JSON.stringify(plugin, null, 2), 'utf-8')
    await writeFile(join(pluginsDir, `${plugin.id}.json`), JSON.stringify(plugin, null, 2), 'utf-8')
    await pluginRuntime.activate(plugin, targetDir)
    return { ...plugin, enabled: true }
  }
  // Ships-with-the-app example plugins — same pattern as builtin flow
  // templates: listed alongside user plugins, not stored on disk, not deletable.
  const BUILTIN_PLUGINS: TermFlowPluginManifest[] = [
    {
      schemaVersion: 1, id: 'termflow.git-essentials', name: 'Git Essentials', version: '1.0.0', builtin: true,
      description: 'Everyday git commands, each in its own terminal.',
      commands: [
        { id: 'status', title: 'Git status', command: 'git status', shell: 'cmd' },
        { id: 'pull', title: 'Git pull', command: 'git pull', shell: 'cmd' },
        { id: 'log', title: 'Commit graph (last 30)', command: 'git log --oneline --graph --decorate -30', shell: 'cmd' },
        { id: 'branches', title: 'List branches', command: 'git branch -a -vv', shell: 'cmd' },
        { id: 'diff', title: 'Working tree diff', command: 'git diff --stat', shell: 'cmd' }
      ]
    },
    {
      schemaVersion: 1, id: 'termflow.node-dev', name: 'Node.js Dev', version: '1.0.0', builtin: true,
      description: 'npm workflow for the current workspace.',
      commands: [
        { id: 'install', title: 'Install dependencies', command: 'npm install', shell: 'cmd' },
        { id: 'dev', title: 'Start dev server', command: 'npm run dev', shell: 'cmd' },
        { id: 'test', title: 'Run tests', command: 'npm test', shell: 'cmd' },
        { id: 'build', title: 'Build', command: 'npm run build', shell: 'cmd' },
        { id: 'outdated', title: 'Outdated packages', command: 'npm outdated', shell: 'cmd' }
      ]
    },
    {
      schemaVersion: 1, id: 'termflow.docker', name: 'Docker Tools', version: '1.0.0', builtin: true,
      description: 'Compose lifecycle and container inspection.',
      commands: [
        { id: 'up', title: 'Compose up', command: 'docker compose up', shell: 'cmd' },
        { id: 'down', title: 'Compose down', command: 'docker compose down', shell: 'cmd' },
        { id: 'ps', title: 'Running containers', command: 'docker ps', shell: 'cmd' },
        { id: 'logs', title: 'Compose logs (follow)', command: 'docker compose logs -f --tail 100', shell: 'cmd' },
        { id: 'prune', title: 'Prune unused data', command: 'docker system prune', shell: 'cmd' }
      ]
    },
    {
      schemaVersion: 1, id: 'termflow.win-system', name: 'Windows System', version: '1.0.0', builtin: true,
      description: 'Quick system inspection on Windows.',
      commands: [
        { id: 'ip', title: 'Network config', command: 'ipconfig /all', shell: 'cmd' },
        { id: 'ports', title: 'Listening ports', command: 'netstat -ano | findstr LISTENING', shell: 'cmd' },
        { id: 'top', title: 'Top processes (CPU)', command: 'powershell -NoLogo -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,Id,CPU,WorkingSet"', shell: 'cmd' },
        { id: 'disk', title: 'Disk usage', command: 'powershell -NoLogo -Command "Get-PSDrive -PSProvider FileSystem"', shell: 'cmd' }
      ]
    }
  ]
  ipcMain.handle(IPC.PLUGIN_LIST, async (): Promise<TermFlowPluginManifest[]> => {
    await ensurePlugins()
    const disabled = await readDisabledPlugins()
    const files = (await readdir(pluginsDir)).filter((file) => file.endsWith('.json'))
    const results = await Promise.all(files.map(async (file) => {
      try { return validatePluginManifest(JSON.parse(await readFile(join(pluginsDir, file), 'utf-8'))) } catch { return null }
    }))
    const user = results.filter((p): p is TermFlowPluginManifest => !!p)
    // Builtins first; a user plugin with the same id overrides the builtin.
    const userIds = new Set(user.map((p) => p.id))
    const plugins = [...BUILTIN_PLUGINS.map(validatePluginManifest).filter((p) => !userIds.has(p.id)), ...user]
      .map((plugin) => ({ ...plugin, enabled: !disabled.has(plugin.id) }))
    await Promise.all(plugins.filter((plugin) => plugin.enabled && plugin.entry).map(async (plugin) => {
      try { await pluginRuntime.activate(plugin, join(pluginsDir, plugin.id)) } catch (error) { console.warn(`[plugin:${plugin.id}]`, error) }
    }))
    return plugins
  })
  ipcMain.handle(IPC.PLUGIN_INSTALL, async (): Promise<TermFlowPluginManifest | null> => {
    const result = await dialog.showOpenDialog(getWindow()!, { title: 'Install TermFlow plugin', properties: ['openFile'], filters: [{ name: 'TermFlow Plugin', extensions: ['json', 'tfplugin'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const info = await stat(result.filePaths[0]); if (info.size > MAX_JSON_FILE_BYTES) throw new Error('Plugin manifest is too large')
    const raw = await readFile(result.filePaths[0], 'utf-8')
    if (result.filePaths[0].endsWith('.tfplugin')) return installPluginBundle(raw)
    const plugin = validatePluginManifest(JSON.parse(raw)); await ensurePlugins(); await writeFile(join(pluginsDir, `${plugin.id}.json`), JSON.stringify(plugin, null, 2), 'utf-8'); return { ...plugin, enabled: true }
  })
  ipcMain.handle(IPC.PLUGIN_SAVE, async (_e, manifest: unknown): Promise<TermFlowPluginManifest> => {
    const plugin = validatePluginManifest(manifest); await ensurePlugins(); await writeFile(join(pluginsDir, `${plugin.id}.json`), JSON.stringify(plugin, null, 2), 'utf-8'); return { ...plugin, enabled: true }
  })
  ipcMain.handle(IPC.PLUGIN_DELETE, async (_e, id: string) => {
    if (!/^[a-z0-9][a-z0-9._-]+$/.test(id)) throw new Error('Plugin ID is invalid')
    try { await unlink(join(pluginsDir, `${id}.json`)) } catch { /* not present */ }
    const disabled = await readDisabledPlugins(); disabled.delete(id); await writeDisabledPlugins(disabled)
  })
  ipcMain.handle(IPC.PLUGIN_SET_ENABLED, async (_e, id: string, enabled: boolean): Promise<void> => {
    if (!/^[a-z0-9][a-z0-9._-]+$/.test(id) || typeof enabled !== 'boolean') throw new Error('Plugin state is invalid')
    const disabled = await readDisabledPlugins()
    if (enabled) disabled.delete(id); else disabled.add(id)
    await writeDisabledPlugins(disabled)
    if (!enabled) await pluginRuntime.deactivate(id)
  })
  ipcMain.handle(IPC.PLUGIN_DIAGNOSTICS, (): ReturnType<PluginRuntime['diagnostics']> => pluginRuntime.diagnostics())
  ipcMain.handle(IPC.PLUGIN_RELOAD, async (_e, id: string): Promise<void> => {
    const plugin = (await readFile(join(pluginsDir, `${id}.json`), 'utf-8').then(JSON.parse).then(validatePluginManifest))
    await pluginRuntime.activate(plugin, join(pluginsDir, id))
  })
  ipcMain.handle(IPC.PLUGIN_REGISTRY_LIST, async () => {
    try { return JSON.parse(await readFile(join(app.getPath('userData'), 'plugin-registry.json'), 'utf-8')) } catch { return [] }
  })
  ipcMain.handle(IPC.PLUGIN_REGISTRY_INSTALL, async (_e, entry: { packageUrl: string; sha256?: string }) => {
    const url = new URL(entry.packageUrl)
    if (url.protocol !== 'https:') throw new Error('Registry packages must use HTTPS')
    const response = await net.fetch(url.toString())
    if (!response.ok) throw new Error(`Plugin download failed: ${response.status}`)
    return installPluginBundle(await response.text(), entry.sha256)
  })

  // ---- Workspace Export/Import (shared helpers also power templates + clone) ----
  function buildWorkspaceExport(workspaceId: string): WorkspaceExport | null {
    const ws = dbApi.listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) return null
    const data = dbApi.exportWorkspaceData(workspaceId)
    return {
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
      envVars: data.envVars.map((v) => v.masked ? { ...v, value: '' } : v)
    }
  }

  function instantiateWorkspaceExport(raw: WorkspaceExport, overrides?: { name?: string; path?: string }): { id: string } | { error: string } {
    try {
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
        name: overrides?.name || raw.workspace.name || 'Imported',
        path: overrides?.path || raw.workspace.path || process.env.USERPROFILE || '',
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
      return { id: ws.id }
    } catch (err) {
      console.error('Import failed:', err)
      return { error: err instanceof Error ? err.message : 'Import failed' }
    }
  }

  ipcMain.handle(IPC.WS_EXPORT, async (_e, workspaceId: string) => {
    const exp = buildWorkspaceExport(workspaceId)
    if (!exp) return
    const win = getWindow()
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export Workspace',
      defaultPath: `${exp.workspace.name.replace(/\s+/g, '_')}.termflow.json`,
      filters: [{ name: 'TermFlow Workspace', extensions: ['termflow.json'] }]
    })
    if (!res.canceled && res.filePath) {
      await writeFile(res.filePath, JSON.stringify(exp, null, 2), 'utf-8')
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
      const file = res.filePaths[0]
      const source = await readFile(file, 'utf-8')
      if (Buffer.byteLength(source, 'utf-8') > MAX_JSON_FILE_BYTES) throw new Error('Import file is too large')
      const checked = validateWorkspaceExport(JSON.parse(source))
      if (!checked.data) throw new Error(checked.errors.join(' '))
      return instantiateWorkspaceExport(checked.data)
    } catch (err) {
      console.error('Import failed:', err)
      return { error: err instanceof Error ? err.message : 'Import failed' }
    }
  })

  // ---- Workspace Clone (duplicate an existing workspace's full layout) ----
  ipcMain.handle(IPC.WS_CLONE, async (_e, workspaceId: string) => {
    const exp = buildWorkspaceExport(workspaceId)
    if (!exp) return { error: 'Workspace not found' }
    return instantiateWorkspaceExport(exp, { name: `${exp.workspace.name} (Copy)` })
  })

  // ---- Workspace Templates (save current layout, reuse it for new workspaces) ----
  const templatesDir = join(app.getPath('userData'), 'templates')
  async function ensureTemplatesDir(): Promise<void> {
    await mkdir(templatesDir, { recursive: true })
  }
  function templateFile(id: string): string {
    return join(templatesDir, `${id}.termflow.json`)
  }

  ipcMain.handle(IPC.TEMPLATE_SAVE, async (_e, workspaceId: string, templateName: string) => {
    const exp = buildWorkspaceExport(workspaceId)
    if (!exp) return { error: 'Workspace not found' }
    await ensureTemplatesDir()
    const id = nanoid()
    const payload = { ...exp, templateName: templateName || exp.workspace.name }
    await writeFile(templateFile(id), JSON.stringify(payload, null, 2), 'utf-8')
    return { id }
  })

  ipcMain.handle(IPC.TEMPLATE_LIST, async () => {
    await ensureTemplatesDir()
    try {
      const files = (await readdir(templatesDir)).filter((f) => f.endsWith('.termflow.json'))
      const entries = await Promise.all(files.map(async (f) => {
        const id = f.replace(/\.termflow\.json$/, '')
        try {
          const data = JSON.parse(await readFile(join(templatesDir, f), 'utf-8'))
          return { id, name: data.templateName || data.workspace?.name || id, savedAt: data.exportedAt || '' }
        } catch {
          return null
        }
      }))
      return entries.filter((t): t is { id: string; name: string; savedAt: string } => !!t)
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC.TEMPLATE_CREATE_WORKSPACE, async (_e, templateId: string, opts?: { name?: string; path?: string }) => {
    try {
      const source = await readFile(templateFile(templateId), 'utf-8')
      const checked = validateWorkspaceExport(JSON.parse(source))
      if (!checked.data) throw new Error(checked.errors.join(' '))
      return instantiateWorkspaceExport(checked.data, opts)
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Template could not be applied' }
    }
  })

  ipcMain.handle(IPC.TEMPLATE_DELETE, async (_e, templateId: string) => {
    try {
      await unlink(templateFile(templateId))
    } catch {
      /* ignore */
    }
  })

  // ---- Agent Flow Templates (multi-agent pipeline wiring, feature: agent flow templates) ----
  const flowTemplatesDir = join(app.getPath('userData'), 'flow-templates')
  async function ensureFlowTemplatesDir(): Promise<void> {
    await mkdir(flowTemplatesDir, { recursive: true })
  }
  function flowTemplateFile(id: string): string {
    return join(flowTemplatesDir, `${id}.json`)
  }

  const BUILTIN_FLOW_TEMPLATES: Array<{
    id: string
    name: string
    builtin: true
    nodes: Array<{ title: string; kind: string; agentRole?: string; startupCommand?: string }>
    connections: Array<{ from: number; to: number; connectionType: string; label?: string; routeBehavior?: string; routeDirection?: string }>
  }> = [
    {
      id: 'builtin:planner-coder-reviewer',
      name: 'Planner → Coder → Reviewer',
      builtin: true,
      nodes: [
        { title: 'Planner', kind: 'claude', agentRole: 'planner' },
        { title: 'Coder', kind: 'claude', agentRole: 'coder' },
        { title: 'Reviewer', kind: 'claude', agentRole: 'reviewer' }
      ],
      connections: [
        { from: 0, to: 1, connectionType: 'control', label: 'plan', routeBehavior: 'marker', routeDirection: 'source_to_target' },
        { from: 1, to: 2, connectionType: 'control', label: 'review', routeBehavior: 'marker', routeDirection: 'source_to_target' }
      ]
    },
    {
      id: 'builtin:researcher-writer-editor',
      name: 'Researcher → Writer → Editor',
      builtin: true,
      nodes: [
        { title: 'Researcher', kind: 'claude', agentRole: 'researcher' },
        { title: 'Writer', kind: 'claude', agentRole: 'writer' },
        { title: 'Editor', kind: 'claude', agentRole: 'editor' }
      ],
      connections: [
        { from: 0, to: 1, connectionType: 'data', label: 'findings', routeBehavior: 'marker', routeDirection: 'source_to_target' },
        { from: 1, to: 2, connectionType: 'control', label: 'draft', routeBehavior: 'marker', routeDirection: 'source_to_target' }
      ]
    },
    {
      id: 'builtin:debug-trio',
      name: 'Reproducer → Fixer → Verifier',
      builtin: true,
      nodes: [
        { title: 'Reproducer', kind: 'claude', agentRole: 'reproducer' },
        { title: 'Fixer', kind: 'claude', agentRole: 'fixer' },
        { title: 'Verifier', kind: 'claude', agentRole: 'verifier' }
      ],
      connections: [
        { from: 0, to: 1, connectionType: 'error', label: 'repro', routeBehavior: 'marker', routeDirection: 'source_to_target' },
        { from: 1, to: 2, connectionType: 'control', label: 'fix', routeBehavior: 'marker', routeDirection: 'source_to_target' }
      ]
    }
  ]

  ipcMain.handle(IPC.FLOW_TEMPLATE_LIST, async () => {
    await ensureFlowTemplatesDir()
    let saved: unknown[] = []
    try {
      const files = (await readdir(flowTemplatesDir)).filter((f) => f.endsWith('.json'))
      const parsed = await Promise.all(files.map(async (f) => {
        try {
          return JSON.parse(await readFile(join(flowTemplatesDir, f), 'utf-8'))
        } catch {
          return null
        }
      }))
      saved = parsed.filter(Boolean)
    } catch {
      saved = []
    }
    return [...BUILTIN_FLOW_TEMPLATES, ...saved]
  })

  ipcMain.handle(IPC.FLOW_TEMPLATE_SAVE, async (_e, name: string, nodes: unknown[], connections: unknown[]) => {
    if (!name?.trim() || !Array.isArray(nodes) || nodes.length < 2) return { error: 'At least 2 agent nodes are required' }
    await ensureFlowTemplatesDir()
    const id = nanoid()
    const payload = { id, name: name.trim(), builtin: false, nodes, connections: connections || [] }
    await writeFile(flowTemplateFile(id), JSON.stringify(payload, null, 2), 'utf-8')
    return { id }
  })

  ipcMain.handle(IPC.FLOW_TEMPLATE_DELETE, async (_e, templateId: string) => {
    if (templateId.startsWith('builtin:')) return
    try {
      await unlink(flowTemplateFile(templateId))
    } catch {
      /* ignore */
    }
  })

  ipcMain.handle(IPC.FLOW_PACKAGE_EXPORT, async () => {
    await ensureFlowTemplatesDir()
    const files = (await readdir(flowTemplatesDir)).filter((file) => file.endsWith('.json'))
    const parsed = await Promise.all(files.map(async (file) => { try { return JSON.parse(await readFile(join(flowTemplatesDir, file), 'utf-8')) } catch { return null } }))
    const templates = parsed.filter(Boolean)
    const result = await dialog.showSaveDialog(getWindow()!, { title: 'Export workflow package', defaultPath: 'termflow-workflows.termflow-package.json', filters: [{ name: 'TermFlow Workflow Package', extensions: ['termflow-package.json'] }] })
    if (!result.canceled && result.filePath) await writeFile(result.filePath, JSON.stringify({ schemaVersion: 1, kind: 'termflow-workflows', exportedAt: new Date().toISOString(), templates }, null, 2), 'utf-8')
  })
  ipcMain.handle(IPC.FLOW_PACKAGE_IMPORT, async (): Promise<number> => {
    const result = await dialog.showOpenDialog(getWindow()!, { title: 'Import workflow package', properties: ['openFile'], filters: [{ name: 'TermFlow Workflow Package', extensions: ['json'] }] })
    if (result.canceled || !result.filePaths[0]) return 0
    const info = await stat(result.filePaths[0]); if (info.size > MAX_JSON_FILE_BYTES) throw new Error('Workflow package is too large')
    const data = JSON.parse(await readFile(result.filePaths[0], 'utf-8')) as { schemaVersion?: number; kind?: string; templates?: unknown[] }
    if (data.schemaVersion !== 1 || data.kind !== 'termflow-workflows' || !Array.isArray(data.templates)) throw new Error('Invalid workflow package')
    await ensureFlowTemplatesDir(); let count = 0
    for (const raw of data.templates) { const template = raw as { id?: string; name?: string; nodes?: unknown[]; connections?: unknown[] }; if (!template.name || !Array.isArray(template.nodes) || !Array.isArray(template.connections)) continue; const id = nanoid(); await writeFile(flowTemplateFile(id), JSON.stringify({ ...template, id, builtin: false }, null, 2), 'utf-8'); count++ }
    return count
  })

  // ---- Task Triggers (process_exit / timer, feature: expanded task triggers) ----
  const taskTriggersDir = join(app.getPath('userData'), 'task-triggers')
  async function ensureTaskTriggersDir(): Promise<void> {
    await mkdir(taskTriggersDir, { recursive: true })
  }
  function taskTriggersFile(workspaceId: string): string {
    return join(taskTriggersDir, `${workspaceId}.json`)
  }
  async function readTaskTriggers(workspaceId: string): Promise<unknown[]> {
    try {
      return JSON.parse(await readFile(taskTriggersFile(workspaceId), 'utf-8'))
    } catch {
      return []
    }
  }

  ipcMain.handle(IPC.TASK_TRIGGER_LIST, async (_e, workspaceId: string) => {
    return readTaskTriggers(workspaceId)
  })

  ipcMain.handle(IPC.TASK_TRIGGER_SAVE, async (_e, trigger: { id?: string; workspaceId: string }) => {
    if (!trigger?.workspaceId) return { error: 'Missing workspace' }
    await ensureTaskTriggersDir()
    const existing = (await readTaskTriggers(trigger.workspaceId)) as Array<{ id: string }>
    const id = trigger.id || nanoid()
    const saved = { ...trigger, id }
    const next = existing.some((t) => t.id === id)
      ? existing.map((t) => (t.id === id ? saved : t))
      : [...existing, saved]
    await writeFile(taskTriggersFile(trigger.workspaceId), JSON.stringify(next, null, 2), 'utf-8')
    return { id }
  })

  ipcMain.handle(IPC.TASK_TRIGGER_DELETE, async (_e, workspaceId: string, id: string) => {
    const existing = (await readTaskTriggers(workspaceId)) as Array<{ id: string }>
    await writeFile(taskTriggersFile(workspaceId), JSON.stringify(existing.filter((t) => t.id !== id), null, 2), 'utf-8')
  })

  // ---- Project Manifest (.termflow.json) ----
  ipcMain.handle(IPC.WS_CHECK_MANIFEST, async (_e, rawCwd: string) => {
    const cwd = validateCwd(rawCwd)
    if (!cwd) return null
    const manifestPath = join(cwd, '.termflow.json')
    try {
      const source = await readFile(manifestPath, 'utf-8')
      if (Buffer.byteLength(source, 'utf-8') > MAX_JSON_FILE_BYTES) return null
      return validateManifest(JSON.parse(source)).data
    } catch {
      return null
    }
  })

  // ---- package.json script runner (feature: task-runner) ----
  ipcMain.handle(IPC.PKG_SCRIPTS, async (_e, rawCwd: string) => {
    const cwd = validateCwd(rawCwd)
    if (!cwd) return null
    const pkgPath = join(cwd, 'package.json')
    try {
      const source = await readFile(pkgPath, 'utf-8')
      if (Buffer.byteLength(source, 'utf-8') > MAX_JSON_FILE_BYTES) return null
      const pkg = JSON.parse(source)
      const scripts: Record<string, string> =
        pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {}
      let packageManager: 'npm' | 'pnpm' | 'yarn' = 'npm'
      if (existsSync(join(cwd, 'pnpm-lock.yaml'))) packageManager = 'pnpm'
      else if (existsSync(join(cwd, 'yarn.lock'))) packageManager = 'yarn'
      return { scripts, packageManager }
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.WS_HEALTH, async (_e, workspaceId: string): Promise<WorkspaceHealthCheck[]> => {
    const ws = dbApi.listWorkspaces().find((item) => item.id === workspaceId)
    if (!ws) return [{ id: 'workspace', label: 'Workspace', status: 'error', detail: 'Workspace not found' }]
    const checks: WorkspaceHealthCheck[] = []
    checks.push({ id: 'path', label: 'Workspace path', status: existsSync(ws.path) ? 'ok' : 'error', detail: ws.path })
    const manifestPath = join(ws.path, '.termflow.json')
    if (!existsSync(manifestPath)) {
      checks.push({ id: 'manifest', label: 'TermFlow manifest', status: 'warning', detail: 'Optional .termflow.json is missing' })
    } else {
      try {
        const result = validateManifest(JSON.parse(await readFile(manifestPath, 'utf-8')))
        checks.push({ id: 'manifest', label: 'TermFlow manifest', status: result.data ? 'ok' : 'error', detail: result.data ? '.termflow.json is valid' : result.errors.join(' ') })
      } catch {
        checks.push({ id: 'manifest', label: 'TermFlow manifest', status: 'error', detail: '.termflow.json cannot be parsed' })
      }
    }
    checks.push({ id: 'package', label: 'Node project', status: existsSync(join(ws.path, 'package.json')) ? 'ok' : 'warning', detail: existsSync(join(ws.path, 'package.json')) ? 'package.json found' : 'No package.json' })
    for (const command of ['git', 'node', 'npm']) {
      try {
        const { stdout } = await execFileAsync('where.exe', [command], { encoding: 'utf-8', timeout: 2000 })
        const found = stdout.split(/\r?\n/)[0]
        checks.push({ id: `runtime:${command}`, label: command, status: 'ok', detail: found })
      } catch {
        checks.push({ id: `runtime:${command}`, label: command, status: 'warning', detail: `${command} is not on PATH` })
      }
    }
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: ws.path, encoding: 'utf-8', timeout: 3000 })
      const branch = stdout.trim()
      checks.push({ id: 'git', label: 'Git repository', status: 'ok', detail: branch || 'detached HEAD' })
    } catch {
      checks.push({ id: 'git', label: 'Git repository', status: 'warning', detail: 'Not a Git repository' })
    }
    return checks
  })

  ipcMain.handle(IPC.DIAGNOSTICS_EXPORT, async (_e, workspaceId: string) => {
    const ws = dbApi.listWorkspaces().find((item) => item.id === workspaceId)
    if (!ws) return
    const layout = dbApi.getLayout(workspaceId)
    const diagnostics = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      workspace: { name: ws.name, pathExists: existsSync(ws.path) },
      counts: {
        terminals: dbApi.listTerminals(workspaceId).length,
        nodes: layout.nodes.length,
        connections: layout.connections.length,
        snippets: dbApi.listSnippets(workspaceId).length,
        sshProfiles: dbApi.listSshProfiles(workspaceId).length,
        envVars: dbApi.listEnvVars(workspaceId).length
      },
      settings: dbApi.getSettings()
    }
    const win = getWindow()
    const res = await dialog.showSaveDialog(win!, { title: 'Export Diagnostics', defaultPath: `termflow-diagnostics-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (!res.canceled && res.filePath) await writeFile(res.filePath, JSON.stringify(diagnostics, null, 2), 'utf-8')
  })

  ipcMain.handle(IPC.DIALOG_CHECK_FILE, async (_e, path: string) => existsSync(path))

  // ---- Git Status ----
  ipcMain.handle(IPC.GIT_STATUS, async (_e, rawCwd: string): Promise<GitStatus | null> => {
    const cwd = validateCwd(rawCwd)
    if (!cwd) return null
    const cached = gitStatusCache.get(cwd)
    if (cached && Date.now() - cached.timestamp < GIT_STATUS_CACHE_TTL_MS) {
      return cached.result
    }
    let result: GitStatus | null
    try {
      const [{ stdout: branchOut }, { stdout: statusOut }] = await Promise.all([
        execFileAsync('git', ['branch', '--show-current'], { cwd, encoding: 'utf-8', timeout: 3000 }),
        execFileAsync('git', ['status', '--porcelain'], { cwd, encoding: 'utf-8', timeout: 3000 })
      ])
      result = { branch: branchOut.trim(), dirty: statusOut.length > 0 }
      // Ahead/behind vs upstream — best-effort, missing upstream just leaves these undefined.
      try {
        const { stdout: aheadBehindOut } = await execFileAsync(
          'git',
          ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
          { cwd, encoding: 'utf-8', timeout: 3000 }
        )
        const [ahead, behind] = aheadBehindOut.trim().split(/\s+/).map(Number)
        if (!Number.isNaN(ahead) && !Number.isNaN(behind)) {
          result.ahead = ahead
          result.behind = behind
        }
      } catch {
        /* no upstream configured, ignore */
      }
    } catch {
      result = null
    }
    setGitStatusCache(cwd, { result, timestamp: Date.now() })
    return result
  })

  ipcMain.handle(IPC.GIT_FETCH, async (_e, rawCwd: string): Promise<{ ok: boolean; message: string }> => {
    const cwd = validateCwd(rawCwd)
    if (!cwd) return { ok: false, message: 'cwd is outside known workspaces' }
    try {
      await execFileAsync('git', ['fetch'], { cwd, encoding: 'utf-8', timeout: 15000 })
      gitStatusCache.delete(cwd)
      return { ok: true, message: 'git fetch tamamlandı' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'git fetch başarısız' }
    }
  })

  ipcMain.handle(IPC.FS_LIST, async (_e, workspaceId: string, path?: string): Promise<WorkspaceFileEntry[]> => {
    const ws = dbApi.listWorkspaces().find((item) => item.id === workspaceId)
    if (!ws) return []
    const dir = pathInside(ws.path, path || ws.path)
    const items = (await readdir(dir, { withFileTypes: true })).filter((item) => !['node_modules', '.git', 'dist', 'out'].includes(item.name))
    const entries = await Promise.all(items.map(async (item) => {
      const fullPath = join(dir, item.name)
      const directory = item.isDirectory()
      let size = 0
      if (!directory) {
        try { size = (await stat(fullPath)).size } catch { size = 0 }
      }
      return { name: item.name, path: fullPath, directory, size }
    }))
    return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  })

  ipcMain.handle(IPC.FS_READ_TEXT, async (_e, workspaceId: string, path: string): Promise<string> => {
    const ws = dbApi.listWorkspaces().find((item) => item.id === workspaceId)
    if (!ws) throw new Error('Workspace not found')
    const target = pathInside(ws.path, path)
    const info = await stat(target)
    if (info.size > MAX_PREVIEW_BYTES) throw new Error('File is too large to preview')
    const data = await readFile(target)
    if (data.includes(0)) throw new Error('Binary files cannot be previewed')
    return data.toString('utf-8')
  })

  ipcMain.handle(IPC.GIT_WORKBENCH, async (_e, rawCwd: string): Promise<GitWorkbenchState> => {
    const cwd = validateCwd(rawCwd)
    if (!cwd) return { branch: '', status: '', diff: '', isRepo: false }
    // A non-git folder is a normal state, not an error — detect it first and
    // return a friendly "not a repo" result instead of throwing a raw dump.
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf-8', timeout: 5000 })
    } catch {
      return { branch: '', status: '', diff: '', isRepo: false }
    }
    try {
      const [{ stdout: branch }, { stdout: status }, { stdout: diff }] = await Promise.all([
        execFileAsync('git', ['branch', '--show-current'], { cwd, encoding: 'utf-8', timeout: 5000 }),
        execFileAsync('git', ['status', '--short'], { cwd, encoding: 'utf-8', timeout: 5000 }),
        execFileAsync('git', ['diff', '--no-ext-diff', '--stat', '--patch'], { cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 })
      ])
      return { branch: branch.trim(), status, diff, isRepo: true }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message.split('\n')[0] : 'git workbench failed')
    }
  })
  ipcMain.handle(IPC.GIT_STAGE, async (_e, rawCwd: string, paths: string[]): Promise<{ ok: boolean; message: string }> => {
    const cwd = validateCwd(rawCwd)
    if (!cwd) return { ok: false, message: 'cwd is outside known workspaces' }
    try {
      await execFileAsync('git', ['add', '--', ...paths], { cwd, timeout: 10000 })
      gitStatusCache.delete(cwd)
      return { ok: true, message: '' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message.split('\n')[0] : 'git add failed' }
    }
  })
  ipcMain.handle(IPC.GIT_UNSTAGE, async (_e, rawCwd: string, paths: string[]): Promise<{ ok: boolean; message: string }> => {
    const cwd = validateCwd(rawCwd)
    if (!cwd) return { ok: false, message: 'cwd is outside known workspaces' }
    try {
      await execFileAsync('git', ['restore', '--staged', '--', ...paths], { cwd, timeout: 10000 })
      gitStatusCache.delete(cwd)
      return { ok: true, message: '' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message.split('\n')[0] : 'git restore failed' }
    }
  })
  ipcMain.handle(IPC.GIT_COMMIT, async (_e, rawCwd: string, message: string): Promise<{ ok: boolean; message: string }> => {
    const cwd = validateCwd(rawCwd)
    if (!cwd) return { ok: false, message: 'cwd is outside known workspaces' }
    if (!message.trim() || message.length > 240) return { ok: false, message: 'Commit message is invalid' }
    try {
      const { stdout } = await execFileAsync('git', ['commit', '-m', message.trim()], { cwd, encoding: 'utf-8', timeout: 30000 })
      gitStatusCache.delete(cwd)
      return { ok: true, message: stdout }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message.split('\n')[0] : 'git commit failed' }
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
      await writeFile(res.filePath, lines.join('\n') + '\n', 'utf-8')
    }
  })

  return pty
}
