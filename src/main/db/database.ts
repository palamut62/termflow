import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'fs'
import { nanoid } from 'nanoid'
import type {
  Workspace,
  TerminalSession,
  WorkspaceLayout,
  CanvasNode,
  AgentConnection,
  LayoutMode,
  AppSettings,
  Snippet,
  HighlightRule,
  SshProfile,
  EnvEntry,
  PaneNode,
  AgentTeam,
  TeamMember,
  TeamTask,
  TeamEvent,
  AgentTeamBundle,
  TeamPermissionPolicy
} from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'

/**
 * Lightweight JSON-file persistence for workspaces, terminals and canvas
 * layouts. The API mirrors a repository layer so the storage backend can be
 * swapped later without touching IPC.
 * Writes are atomic (temp file + rename). (PRD §15 — same schema, JSON shape.)
 *
 * Mutations are debounced (500ms trailing); flushPersist() is called from the
 * app's before-quit handler so pending writes never get lost on shutdown.
 */

interface StoreShape {
  workspaces: Workspace[]
  terminals: TerminalSession[]
  nodes: CanvasNode[]
  connections: AgentConnection[]
  viewports: Record<string, { layoutMode: LayoutMode; zoom: number; x: number; y: number; activeNodeId?: string }>
  settings: AppSettings
  snippets: Snippet[]
  highlightRules: HighlightRule[]
  sshProfiles: SshProfile[]
  envVars: EnvEntry[]
  teams: AgentTeam[]
  teamMembers: TeamMember[]
  teamTasks: TeamTask[]
  teamEvents: TeamEvent[]
  /** v0.2.1's on-disk shape for this feature, kept only so initDatabase() can
   *  migrate it into `teams`/etc. on first load after upgrading; never
   *  written back to once migrated. */
  agentTeams?: AgentTeam[]
}

let store: StoreShape
let filePath: string

function empty(): StoreShape {
  return {
    workspaces: [], terminals: [], nodes: [], connections: [],
    viewports: {}, settings: { ...DEFAULT_SETTINGS },
    snippets: [], highlightRules: [], sshProfiles: [], envVars: [],
    teams: [], teamMembers: [], teamTasks: [], teamEvents: []
  }
}

// ---- Settings ----

export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...store.settings }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  store.settings = { ...getSettings(), ...patch }
  persist()
  return store.settings
}

// ---- Persistence (debounced, atomic write) ----

const PERSIST_DEBOUNCE_MS = 500
const BACKUP_INTERVAL_MS = 60_000

let persistTimer: ReturnType<typeof setTimeout> | null = null
let lastBackupAt = 0

/** Synchronous atomic write. Backs up at most once per BACKUP_INTERVAL_MS. */
function writeStore(): void {
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  const nowMs = Date.now()
  if (existsSync(filePath) && nowMs - lastBackupAt >= BACKUP_INTERVAL_MS) {
    copyFileSync(filePath, filePath + '.bak')
    lastBackupAt = nowMs
  }
  renameSync(tmp, filePath)
}

/**
 * Schedule a persist. Trailing debounce: coalesces bursts of mutations into a
 * single disk write after PERSIST_DEBOUNCE_MS of quiescence. If a timer is
 * already pending it is left in place (no reset), so writes cannot be starved.
 */
function persist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeStore()
  }, PERSIST_DEBOUNCE_MS)
}

/**
 * Cancel any pending debounced write and flush the store to disk immediately
 * (synchronous). Must be called on app shutdown so buffered mutations are not
 * lost.
 */
export function flushPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  writeStore()
}

function now(): string {
  return new Date().toISOString()
}

export function initDatabase(): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  filePath = join(dir, 'termflow.json')
  if (existsSync(filePath)) {
    try {
      store = { ...empty(), ...JSON.parse(readFileSync(filePath, 'utf-8')) }
    } catch {
      const corruptPath = filePath.replace(/\.json$/, `.corrupt-${Date.now()}.json`)
      renameSync(filePath, corruptPath)
      const backupPath = filePath + '.bak'
      if (existsSync(backupPath)) {
        try {
          store = { ...empty(), ...JSON.parse(readFileSync(backupPath, 'utf-8')) }
          persist()
          return
        } catch {
          // Keep the corrupt primary file and fall back to a new store.
        }
      }
      store = empty()
    }
  } else {
    store = empty()
  }
  // One-time migration from v0.2.1's simpler Agent Teams shape (`agentTeams`
  // field, no concurrencyLimit/canBypass/retryCount) into the current one, so
  // existing users don't lose in-flight teams/tasks when upgrading.
  if (store.agentTeams?.length && !store.teams?.length) {
    store.teams = store.agentTeams.map((t) => ({
      ...t,
      concurrencyLimit: (t as AgentTeam).concurrencyLimit ?? 2
    }))
  }
  delete store.agentTeams
  // Security: bypass grants are runtime-only and must never re-arm themselves
  // from a saved file across restarts (mirrors settings.agentAutoApprove).
  store.teamMembers = (store.teamMembers ?? []).map((m) => ({ ...m, canBypass: false, retryCount: m.retryCount ?? 0 }))
  store.teamTasks = (store.teamTasks ?? []).map((t, i) => ({ ...t, order: t.order ?? i, retryCount: t.retryCount ?? 0, maxRetries: t.maxRetries ?? 2 }))
  store.teamEvents = store.teamEvents ?? []
  if (store.workspaces.length === 0) {
    createWorkspace({
      name: 'Default',
      path: app.getPath('home'),
      description: 'Default workspace',
      defaultLayoutMode: 'manual'
    })
  } else {
    persist()
  }
}

// ---- Workspaces ----

export function listWorkspaces(): Workspace[] {
  return [...store.workspaces].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export function createWorkspace(input: {
  name: string
  path: string
  description?: string
  icon?: string
  defaultLayoutMode?: LayoutMode
}): Workspace {
  const ts = now()
  const ws: Workspace = {
    id: nanoid(),
    name: input.name,
    path: input.path,
    description: input.description,
    icon: input.icon,
    defaultLayoutMode: input.defaultLayoutMode ?? 'manual',
    createdAt: ts,
    updatedAt: ts,
    lastOpenedAt: ts
  }
  store.workspaces.push(ws)
  store.viewports[ws.id] = { layoutMode: ws.defaultLayoutMode, zoom: 1, x: 0, y: 0 }
  persist()
  return ws
}

export function updateWorkspace(id: string, patch: Partial<Workspace>): void {
  const ws = store.workspaces.find((w) => w.id === id)
  if (!ws) return
  Object.assign(ws, patch, { updatedAt: now() })
  persist()
}

export function deleteWorkspace(id: string): void {
  store.workspaces = store.workspaces.filter((w) => w.id !== id)
  store.terminals = store.terminals.filter((t) => t.workspaceId !== id)
  store.nodes = store.nodes.filter((n) => n.workspaceId !== id)
  store.connections = store.connections.filter((c) => c.workspaceId !== id)
  store.snippets = store.snippets.filter((s) => s.workspaceId !== id)
  store.highlightRules = store.highlightRules.filter((r) => r.workspaceId !== id)
  store.sshProfiles = store.sshProfiles.filter((p) => p.workspaceId !== id)
  store.envVars = store.envVars.filter((e) => e.workspaceId !== id)
  const removedTeamIds = new Set(store.teams.filter((t) => t.workspaceId === id).map((t) => t.id))
  store.teams = store.teams.filter((t) => t.workspaceId !== id)
  store.teamMembers = store.teamMembers.filter((m) => !removedTeamIds.has(m.teamId))
  store.teamTasks = store.teamTasks.filter((t) => !removedTeamIds.has(t.teamId))
  store.teamEvents = store.teamEvents.filter((e) => !removedTeamIds.has(e.teamId))
  delete store.viewports[id]
  persist()
}

// ---- Terminals ----

export function listTerminals(workspaceId: string): TerminalSession[] {
  return store.terminals
    .filter((t) => t.workspaceId === workspaceId)
    .map((t) => ({ ...t, status: 'stopped' as const }))
}

export function upsertTerminal(t: TerminalSession): void {
  const idx = store.terminals.findIndex((x) => x.id === t.id)
  const record = { ...t, updatedAt: now() }
  if (idx >= 0) store.terminals[idx] = record
  else store.terminals.push(record)
  persist()
}

export function deleteTerminal(id: string): void {
  store.terminals = store.terminals.filter((t) => t.id !== id)
  store.nodes = store.nodes.filter((n) => n.terminalId !== id && !paneHasTerminal(n.panes, id))
  persist()
}

// ---- Node migration: convert legacy single-terminal nodes to pane-tree ----
function migrateNode(node: CanvasNode): CanvasNode {
  if (!node.panes && node.terminalId) {
    return {
      ...node,
      panes: { type: 'leaf', terminalId: node.terminalId, title: node.title },
      activePaneId: node.terminalId
    }
  }
  return node
}

function paneHasTerminal(pane: PaneNode | undefined, terminalId: string): boolean {
  if (!pane) return false
  if (pane.type === 'leaf') return pane.terminalId === terminalId
  return paneHasTerminal(pane.a, terminalId) || paneHasTerminal(pane.b, terminalId)
}

export function remapPaneIds(
  pane: PaneNode | undefined,
  remap: (oldId: string) => string
): PaneNode | undefined {
  if (!pane) return undefined
  if (pane.type === 'leaf') return { ...pane, terminalId: remap(pane.terminalId) }
  return {
    ...pane,
    a: remapPaneIds(pane.a, remap)!,
    b: remapPaneIds(pane.b, remap)!
  }
}

// ---- Layout ----

export function getLayout(workspaceId: string): WorkspaceLayout {
  const nodes = store.nodes.filter((n) => n.workspaceId === workspaceId).map(migrateNode)
  const connections = store.connections.filter((c) => c.workspaceId === workspaceId)
  const vp = store.viewports[workspaceId] ?? { layoutMode: 'manual' as LayoutMode, zoom: 1, x: 0, y: 0 }
  return {
    workspaceId,
    nodes,
    connections,
    layoutMode: vp.layoutMode,
    viewport: { zoom: vp.zoom, x: vp.x, y: vp.y },
    activeNodeId: vp.activeNodeId
  }
}

// ---- Snippets ----

export function listSnippets(workspaceId?: string): Snippet[] {
  return store.snippets.filter((s) => !workspaceId || s.workspaceId === workspaceId || s.scope === 'global')
}

export function createSnippet(input: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>): Snippet {
  const ts = now()
  const s: Snippet = { id: nanoid(), ...input, createdAt: ts, updatedAt: ts }
  store.snippets.push(s)
  persist()
  return s
}

export function updateSnippet(id: string, patch: Partial<Snippet>): void {
  const idx = store.snippets.findIndex((s) => s.id === id)
  if (idx < 0) return
  store.snippets[idx] = { ...store.snippets[idx], ...patch, updatedAt: now() }
  persist()
}

export function deleteSnippet(id: string): void {
  store.snippets = store.snippets.filter((s) => s.id !== id)
  persist()
}

// ---- Highlight Rules ----

export function listHighlightRules(workspaceId?: string): HighlightRule[] {
  return store.highlightRules.filter((r) => !workspaceId || !r.workspaceId || r.workspaceId === workspaceId)
}

export function createHighlightRule(input: Omit<HighlightRule, 'id'>): HighlightRule {
  const r: HighlightRule = { id: nanoid(), ...input }
  store.highlightRules.push(r)
  persist()
  return r
}

export function updateHighlightRule(id: string, patch: Partial<HighlightRule>): void {
  const idx = store.highlightRules.findIndex((r) => r.id === id)
  if (idx < 0) return
  store.highlightRules[idx] = { ...store.highlightRules[idx], ...patch }
  persist()
}

export function deleteHighlightRule(id: string): void {
  store.highlightRules = store.highlightRules.filter((r) => r.id !== id)
  persist()
}

// ---- SSH Profiles ----

export function listSshProfiles(workspaceId: string): SshProfile[] {
  return store.sshProfiles.filter((p) => p.workspaceId === workspaceId)
}

export function createSshProfile(input: Omit<SshProfile, 'id' | 'createdAt'>): SshProfile {
  const p: SshProfile = { id: nanoid(), ...input, createdAt: now() }
  store.sshProfiles.push(p)
  persist()
  return p
}

export function updateSshProfile(id: string, patch: Partial<SshProfile>): void {
  const idx = store.sshProfiles.findIndex((p) => p.id === id)
  if (idx < 0) return
  store.sshProfiles[idx] = { ...store.sshProfiles[idx], ...patch }
  persist()
}

export function deleteSshProfile(id: string): void {
  store.sshProfiles = store.sshProfiles.filter((p) => p.id !== id)
  persist()
}

// ---- Env Vars ----

export function listEnvVars(workspaceId: string): EnvEntry[] {
  return store.envVars.filter((e) => e.workspaceId === workspaceId)
}

export function getEnvVar(id: string): EnvEntry | undefined {
  return store.envVars.find((e) => e.id === id)
}

export function createEnvVar(input: Omit<EnvEntry, 'id'>): EnvEntry {
  const e: EnvEntry = { id: nanoid(), ...input }
  store.envVars.push(e)
  persist()
  return e
}

export function updateEnvVar(id: string, patch: Partial<EnvEntry>): void {
  const idx = store.envVars.findIndex((e) => e.id === id)
  if (idx < 0) return
  store.envVars[idx] = { ...store.envVars[idx], ...patch }
  persist()
}

export function deleteEnvVar(id: string): void {
  store.envVars = store.envVars.filter((e) => e.id !== id)
  persist()
}

// ---- Workspace Export/Import ----

export function exportWorkspaceData(workspaceId: string): {
  terminals: TerminalSession[]
  nodes: CanvasNode[]
  connections: AgentConnection[]
  snippets: Snippet[]
  highlightRules: HighlightRule[]
  sshProfiles: SshProfile[]
  envVars: EnvEntry[]
  viewport: { zoom: number; x: number; y: number } | null
} {
  return {
    terminals: store.terminals.filter((t) => t.workspaceId === workspaceId),
    nodes: store.nodes.filter((n) => n.workspaceId === workspaceId),
    connections: store.connections.filter((c) => c.workspaceId === workspaceId),
    snippets: store.snippets.filter((s) => s.workspaceId === workspaceId),
    highlightRules: store.highlightRules.filter((r) => r.workspaceId === workspaceId),
    sshProfiles: store.sshProfiles.filter((p) => p.workspaceId === workspaceId),
    envVars: store.envVars.filter((e) => e.workspaceId === workspaceId),
    viewport: store.viewports[workspaceId] ?? null
  }
}

export function importWorkspaceData(
  workspaceId: string,
  terminals: TerminalSession[],
  nodes: CanvasNode[],
  connections: AgentConnection[],
  snippets: Snippet[],
  highlightRules: HighlightRule[],
  sshProfiles: SshProfile[],
  envVars: EnvEntry[],
  viewport: { zoom: number; x: number; y: number }
): void {
  store.terminals = store.terminals.filter((t) => t.workspaceId !== workspaceId).concat(terminals)
  store.nodes = store.nodes.filter((n) => n.workspaceId !== workspaceId).concat(nodes)
  store.connections = store.connections.filter((c) => c.workspaceId !== workspaceId).concat(connections)
  store.snippets = store.snippets.filter((s) => s.workspaceId !== workspaceId).concat(snippets)
  store.highlightRules = store.highlightRules.filter((r) => r.workspaceId !== workspaceId).concat(highlightRules)
  store.sshProfiles = store.sshProfiles.filter((p) => p.workspaceId !== workspaceId).concat(sshProfiles)
  store.envVars = store.envVars.filter((e) => e.workspaceId !== workspaceId).concat(envVars)
  store.viewports[workspaceId] = { layoutMode: 'manual' as LayoutMode, ...viewport }
  persist()
}

export function saveLayout(layout: WorkspaceLayout): void {
  store.nodes = store.nodes.filter((n) => n.workspaceId !== layout.workspaceId).concat(layout.nodes)
  store.connections = store.connections
    .filter((c) => c.workspaceId !== layout.workspaceId)
    .concat(layout.connections)
  store.viewports[layout.workspaceId] = {
    layoutMode: layout.layoutMode,
    zoom: layout.viewport.zoom,
    x: layout.viewport.x,
    y: layout.viewport.y,
    activeNodeId: layout.activeNodeId
  }
  persist()
}

// ---- Agent Teams (shared task store + coordinator) ----

// Role lineup by team size, matching the roles the coordinator/UI know how to
// brief (see ROLE_INSTRUCTIONS in AgentTeamsModal.tsx).
const TEAM_ROLE_LINEUPS: Record<number, string[]> = {
  3: ['lead', 'developer', 'tester'],
  4: ['lead', 'researcher', 'developer', 'tester'],
  5: ['lead', 'researcher', 'developer', 'tester', 'reviewer']
}

function teamBundle(team: AgentTeam): AgentTeamBundle {
  return {
    team,
    members: store.teamMembers.filter((m) => m.teamId === team.id),
    tasks: store.teamTasks.filter((t) => t.teamId === team.id).sort((a, b) => a.order - b.order),
    events: store.teamEvents.filter((e) => e.teamId === team.id).slice(-200)
  }
}

export function listTeams(workspaceId: string): AgentTeamBundle[] {
  return store.teams
    .filter((t) => t.workspaceId === workspaceId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(teamBundle)
}

export function createTeam(input: {
  workspaceId: string
  objective: string
  permissionPolicy: TeamPermissionPolicy
  teamSize: 3 | 4 | 5
  concurrencyLimit?: number
}): AgentTeamBundle {
  const objective = input.objective.trim().slice(0, 2000)
  if (!objective) throw new Error('Takım hedefi boş olamaz')
  const ts = now()
  const team: AgentTeam = {
    id: nanoid(),
    workspaceId: input.workspaceId,
    name: objective.length > 48 ? `${objective.slice(0, 45)}...` : objective,
    objective,
    permissionPolicy: input.permissionPolicy,
    status: 'draft',
    concurrencyLimit: input.concurrencyLimit ?? Math.min(2, input.teamSize),
    createdAt: ts,
    updatedAt: ts
  }
  store.teams.push(team)

  const lineup = TEAM_ROLE_LINEUPS[input.teamSize] ?? TEAM_ROLE_LINEUPS[4]
  const labels: Record<string, string> = {
    lead: 'Takım Lideri', researcher: 'Araştırmacı', developer: 'Geliştirici', tester: 'Test Uzmanı', reviewer: 'Kod İnceleyici'
  }
  const members: TeamMember[] = lineup.map((role, i) => ({
    id: nanoid(),
    teamId: team.id,
    name: labels[role] ?? `${role[0].toUpperCase()}${role.slice(1)} ${i + 1}`,
    role,
    status: 'idle',
    canBypass: false,
    retryCount: 0
  }))
  store.teamMembers.push(...members)

  // Auto-split the objective into one starter task per non-lead member; the
  // lead's implicit job is coordination/synthesis, not a queued task. The
  // coordinator (AgentTeamsModal.tsx's coordinatorTick) hands these out as
  // members free up. Dependencies/acceptanceCriteria mirror v0.2.1's simpler
  // plan->build->test->review pipeline so downstream tooling that reads them
  // keeps working, but they're informational only for the current coordinator.
  const workers = members.filter((m) => m.role !== 'lead')
  const ordered = workers.length ? workers : members
  const tasks: TeamTask[] = ordered.map((m, i) => {
    const prevId = i > 0 ? ordered[i - 1].id : undefined
    return {
      id: nanoid(),
      teamId: team.id,
      title: `${m.role[0].toUpperCase()}${m.role.slice(1)} görevi`,
      description: objective,
      assigneeId: m.id,
      status: 'ready',
      order: i,
      retryCount: 0,
      maxRetries: 2,
      dependencies: prevId ? [prevId] : [],
      acceptanceCriteria: []
    }
  })
  store.teamTasks.push(...tasks)
  store.teamEvents.push({ id: nanoid(), teamId: team.id, type: 'team.created', message: 'Takım ve görev planı oluşturuldu.', createdAt: ts })

  persist()
  return teamBundle(team)
}

export function updateTeam(id: string, patch: Partial<AgentTeam>): AgentTeamBundle | undefined {
  const team = store.teams.find((t) => t.id === id)
  if (!team) return undefined
  Object.assign(team, patch, { updatedAt: now() })
  if (patch.status) {
    store.teamEvents.push({
      id: nanoid(),
      teamId: id,
      type: patch.status === 'running' ? 'team.started' : 'team.stopped',
      message: patch.status === 'running' ? 'Takım çalışmaya başladı.' : `Takım durumu: ${patch.status}`,
      createdAt: team.updatedAt
    })
  }
  persist()
  return teamBundle(team)
}

export function deleteTeam(id: string): void {
  store.teams = store.teams.filter((t) => t.id !== id)
  store.teamMembers = store.teamMembers.filter((m) => m.teamId !== id)
  store.teamTasks = store.teamTasks.filter((t) => t.teamId !== id)
  store.teamEvents = store.teamEvents.filter((e) => e.teamId !== id)
  persist()
}

export function updateTeamMember(id: string, patch: Partial<TeamMember>): TeamMember | undefined {
  const idx = store.teamMembers.findIndex((m) => m.id === id)
  if (idx < 0) return undefined
  // Security: a bypass grant never survives past this call — it only reflects
  // the running session's live choice and is re-derived, never persisted as
  // "always on" (mirrors the global agentAutoApprove runtime-only handling).
  store.teamMembers[idx] = { ...store.teamMembers[idx], ...patch }
  persist()
  return store.teamMembers[idx]
}

export function createTeamTask(input: Omit<TeamTask, 'id' | 'retryCount'>): TeamTask {
  const task: TeamTask = { id: nanoid(), retryCount: 0, ...input }
  store.teamTasks.push(task)
  persist()
  return task
}

export function updateTeamTask(id: string, patch: Partial<TeamTask>): TeamTask | undefined {
  const idx = store.teamTasks.findIndex((t) => t.id === id)
  if (idx < 0) return undefined
  store.teamTasks[idx] = { ...store.teamTasks[idx], ...patch }
  if (patch.status) {
    store.teamEvents.push({ id: nanoid(), teamId: store.teamTasks[idx].teamId, taskId: id, type: 'task.updated', message: `${store.teamTasks[idx].title}: ${patch.status}`, createdAt: now() })
  }
  persist()
  return store.teamTasks[idx]
}

export function getTeamBundle(id: string): AgentTeamBundle | undefined {
  const team = store.teams.find((t) => t.id === id)
  return team ? teamBundle(team) : undefined
}
