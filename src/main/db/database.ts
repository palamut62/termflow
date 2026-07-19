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
  AgentTeamBundle,
  AgentTeam,
  TeamMember,
  TeamTask,
  TeamEvent,
  CreateAgentTeamInput
} from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { getAgentTeamTemplate } from '../../shared/agentTeamTemplates'

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
  agentTeams: AgentTeam[]
  teamMembers: TeamMember[]
  teamTasks: TeamTask[]
  teamEvents: TeamEvent[]
}

let store: StoreShape
let filePath: string

function empty(): StoreShape {
  return {
    workspaces: [], terminals: [], nodes: [], connections: [],
    viewports: {}, settings: { ...DEFAULT_SETTINGS },
    snippets: [], highlightRules: [], sshProfiles: [], envVars: [],
    agentTeams: [], teamMembers: [], teamTasks: [], teamEvents: []
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

function migrateAgentTeamsToEnglish(): void {
  const memberNames: Record<string, string> = { 'Takım Lideri': 'Team Lead', 'Araştırmacı': 'Researcher', 'Geliştirici': 'Developer', 'Test Uzmanı': 'Test Engineer', 'Kod İnceleyici': 'Code Reviewer' }
  const taskTitles: Record<string, string> = { 'Hedefi incele ve planla': 'Investigate and plan', 'Çözümü uygula': 'Implement the solution', 'Doğrula ve test et': 'Validate and test', 'Son kod incelemesi': 'Final code review', 'Sonucu sentezle': 'Synthesize the outcome' }
  const messages: Record<string, string> = {
    'Takım ve görev planı oluşturuldu.': 'Team and task plan created.',
    'Takım çalışmaya başladı.': 'Team started.',
    'Takım ve çalışan görevler duraklatıldı.': 'The team and its active tasks were paused.',
    'Takımın doğrulanmış değişiklikleri ana projeye uygulandı.': 'The team changes were applied to the main workspace.',
    'Uygulama planı hazır. Kod değişikliği için kullanıcı onayı bekleniyor.': 'The implementation plan is ready. Waiting for approval to change code.'
  }
  for (const member of store.teamMembers) member.name = memberNames[member.name] ?? member.name
  for (const task of store.teamTasks) {
    task.title = taskTitles[task.title] ?? task.title
    task.description = task.description
      .replace('Onaylanan plana göre hedefi gerçekleştir:', 'Implement the approved plan for this objective:')
      .replace('Uygulanan değişikliği test et ve kanıtları raporla.', 'Test the implementation independently and report concrete evidence.')
      .replace('Değişiklikleri güvenlik, doğruluk ve kapsam açısından incele.', 'Review the changes for correctness, security, regressions, and scope.')
      .replace('Tüm görev sonuçlarını birleştir; yapılanları, test kanıtlarını ve kalan riskleri kullanıcı dilinde özetle.', 'Combine all task results and summarize the changes, test evidence, and remaining risks in plain language.')
    const criteria: Record<string, string> = { 'İlgili kod ve riskler belirlendi': 'Relevant code and risks identified', 'Uygulanabilir plan hazırlandı': 'Actionable plan prepared', 'Değişiklik hedefle sınırlı': 'Changes remain within scope', 'Kod derleniyor': 'Code builds successfully', 'İlgili testler geçti': 'Relevant tests pass', 'Kullanıcı sonucu doğrulandı': 'User-visible outcome verified', 'Engelleyici bulgu kalmadı': 'No blocking findings remain', 'Sonuç açık ve doğrulanabilir': 'Outcome is clear and verifiable', 'Kalan riskler belirtildi': 'Remaining risks are documented' }
    task.acceptanceCriteria = task.acceptanceCriteria.map((item) => criteria[item] ?? item)
    if (task.result === 'Kod değişikliğine başlamadan önce kullanıcı onayı gerekiyor.') task.result = 'User approval is required before changing code.'
    if (task.result === 'Kullanıcı tarafından durduruldu.') task.result = 'Stopped by the user.'
    if (task.result === 'Görev duraklatıldı; devam edildiğinde yeniden çalıştırılacak.') task.result = 'Task paused; it will restart when the team resumes.'
  }
  for (const event of store.teamEvents) {
    event.message = messages[event.message] ?? event.message
    for (const [oldTitle, newTitle] of Object.entries(taskTitles)) event.message = event.message.replace(oldTitle, newTitle)
    for (const [oldName, newName] of Object.entries(memberNames)) event.message = event.message.replace(oldName, newName)
    event.message = event.message.replace('Takım durumu:', 'Team status:').replace(' görevine başladı.', '.').replace(': tamamlandı', ': completed').replace(': başarısız', ': failed')
  }
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
  migrateAgentTeamsToEnglish()
  // Agent subprocesses cannot survive an app restart. Resume their durable
  // task records in a safe paused state instead of showing phantom workers.
  for (const team of store.agentTeams) if (team.status === 'running') team.status = 'paused'
  for (const member of store.teamMembers) if (member.status === 'working') member.status = 'idle'
  for (const task of store.teamTasks) if (task.status === 'working') task.status = 'ready'
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
  const teamIds = new Set(store.agentTeams.filter((team) => team.workspaceId === id).map((team) => team.id))
  store.agentTeams = store.agentTeams.filter((team) => !teamIds.has(team.id))
  store.teamMembers = store.teamMembers.filter((member) => !teamIds.has(member.teamId))
  store.teamTasks = store.teamTasks.filter((task) => !teamIds.has(task.teamId))
  store.teamEvents = store.teamEvents.filter((event) => !teamIds.has(event.teamId))
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

// ---- Agent Teams ----

function teamBundle(team: AgentTeam): AgentTeamBundle {
  return {
    team: { ...team },
    members: store.teamMembers.filter((member) => member.teamId === team.id),
    tasks: store.teamTasks.filter((task) => task.teamId === team.id),
    events: store.teamEvents.filter((event) => event.teamId === team.id).slice(-200)
  }
}

export function listAgentTeams(workspaceId: string): AgentTeamBundle[] {
  return store.agentTeams
    .filter((team) => team.workspaceId === workspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(teamBundle)
}

export function getAgentTeam(id: string): AgentTeamBundle | undefined {
  const team = store.agentTeams.find((item) => item.id === id)
  return team ? teamBundle(team) : undefined
}

export function appendTeamEvent(input: Omit<TeamEvent, 'id' | 'createdAt'>): TeamEvent {
  const event: TeamEvent = { id: nanoid(), ...input, createdAt: now() }
  store.teamEvents.push(event)
  if (store.teamEvents.length > 5000) store.teamEvents.splice(0, store.teamEvents.length - 5000)
  persist()
  return event
}

export function createAgentTeam(input: CreateAgentTeamInput): AgentTeamBundle {
  const objective = input.objective.trim().slice(0, 2000)
  if (!objective) throw new Error('Team objective cannot be empty')
  if (![3, 4, 5].includes(input.teamSize)) throw new Error('Invalid team size')
  const ts = now()
  const teamId = nanoid()
  const template = getAgentTeamTemplate(input.templateId)
  const team: AgentTeam = {
    id: teamId,
    workspaceId: input.workspaceId,
    name: objective.length > 62 ? `${objective.slice(0, 59)}...` : objective,
    objective,
    status: 'draft',
    permissionPolicy: input.permissionPolicy,
    templateId: template?.id,
    createdAt: ts,
    updatedAt: ts
  }
  const defaultMembers: Array<Pick<TeamMember, 'name' | 'role' | 'provider'> & { instructions?: string }> = [
    { name: 'Team Lead', role: 'lead', provider: 'claude' },
    { name: 'Researcher', role: 'researcher', provider: 'claude' },
    { name: 'Developer', role: 'developer', provider: 'claude' },
    { name: 'Test Engineer', role: 'tester', provider: 'claude' },
    { name: 'Code Reviewer', role: 'reviewer', provider: 'claude' }
  ]
  const memberPlan = (template?.members ?? defaultMembers).slice(0, input.teamSize)
  const members = memberPlan.map<TeamMember>((item) => ({ id: nanoid(), teamId, ...item, status: 'idle' }))
  const member = (role: TeamMember['role']): string | undefined => members.find((item) => item.role === role)?.id
  let tasks: TeamTask[]
  if (template) {
    const taskIds = new Map(template.tasks.map((task) => [task.key, nanoid()]))
    tasks = template.tasks.map((task) => ({
      id: taskIds.get(task.key)!, teamId, title: task.title,
      description: `${task.description}\n\nTeam objective: ${objective}`,
      assigneeId: member(task.assigneeRole) ?? member('lead'), status: 'ready',
      dependencies: task.dependencies.map((key) => taskIds.get(key)).filter((id): id is string => Boolean(id)),
      acceptanceCriteria: task.acceptanceCriteria, updatedAt: ts
    }))
  } else {
    const planId = nanoid()
    const buildId = nanoid()
    const testId = nanoid()
    tasks = [
      { id: planId, teamId, title: 'Investigate and plan', description: objective, assigneeId: member('researcher') ?? member('lead'), status: 'ready', dependencies: [], acceptanceCriteria: ['Relevant code and risks identified', 'Actionable plan prepared'], updatedAt: ts },
      { id: buildId, teamId, title: 'Implement the solution', description: `Implement the approved plan for this objective: ${objective}`, assigneeId: member('developer') ?? member('lead'), status: 'ready', dependencies: [planId], acceptanceCriteria: ['Changes remain within scope', 'Code builds successfully'], updatedAt: ts },
      { id: testId, teamId, title: 'Validate and test', description: 'Test the implementation independently and report concrete evidence.', assigneeId: member('tester') ?? member('lead'), status: 'ready', dependencies: [buildId], acceptanceCriteria: ['Relevant tests pass', 'User-visible outcome verified'], updatedAt: ts }
    ]
    const reviewerId = member('reviewer')
    let finalDependency = testId
    if (reviewerId) {
      const reviewId = nanoid()
      tasks.push({ id: reviewId, teamId, title: 'Final code review', description: 'Review the changes for correctness, security, regressions, and scope.', assigneeId: reviewerId, status: 'ready', dependencies: [testId], acceptanceCriteria: ['No blocking findings remain'], updatedAt: ts })
      finalDependency = reviewId
    }
    tasks.push({ id: nanoid(), teamId, title: 'Synthesize the outcome', description: 'Combine all task results and summarize the changes, test evidence, and remaining risks in plain language.', assigneeId: member('lead'), status: 'ready', dependencies: [finalDependency], acceptanceCriteria: ['Outcome is clear and verifiable', 'Remaining risks are documented'], updatedAt: ts })
  }
  store.agentTeams.push(team)
  store.teamMembers.push(...members)
  store.teamTasks.push(...tasks)
  store.teamEvents.push({ id: nanoid(), teamId, type: 'team.created', message: 'Team and task plan created.', createdAt: ts })
  persist()
  return teamBundle(team)
}

export function updateAgentTeam(id: string, patch: Partial<Pick<AgentTeam, 'status' | 'name' | 'worktreePath' | 'worktreeBranch' | 'baseCommit' | 'appliedAt'>>): AgentTeamBundle {
  const team = store.agentTeams.find((item) => item.id === id)
  if (!team) throw new Error('Team not found')
  const { name, ...rest } = patch
  if (name) team.name = name.trim().slice(0, 80)
  Object.assign(team, rest)
  team.updatedAt = now()
  if (patch.status) store.teamEvents.push({ id: nanoid(), teamId: id, type: patch.status === 'running' ? 'team.started' : 'team.stopped', message: patch.status === 'running' ? 'Team started.' : `Team status: ${patch.status}`, createdAt: team.updatedAt })
  persist()
  return teamBundle(team)
}

export function updateTeamMember(id: string, patch: Partial<Pick<TeamMember, 'status' | 'terminalId' | 'sessionId' | 'provider' | 'executionProfileId'>>): void {
  const member = store.teamMembers.find((item) => item.id === id)
  if (!member) throw new Error('Team member not found')
  Object.assign(member, patch)
  persist()
}

export function updateTeamTask(id: string, patch: Partial<Pick<TeamTask, 'status' | 'result' | 'assigneeId' | 'approved'>>): void {
  const task = store.teamTasks.find((item) => item.id === id)
  if (!task) throw new Error('Task not found')
  Object.assign(task, patch, { updatedAt: now() })
  store.teamEvents.push({ id: nanoid(), teamId: task.teamId, taskId: task.id, type: 'task.updated', message: `${task.title}: ${task.status}`, createdAt: task.updatedAt })
  persist()
}

export function getTeamMember(id: string): TeamMember | undefined {
  return store.teamMembers.find((item) => item.id === id)
}

export function getTeamTask(id: string): TeamTask | undefined {
  return store.teamTasks.find((item) => item.id === id)
}

export function deleteAgentTeam(id: string): void {
  store.agentTeams = store.agentTeams.filter((team) => team.id !== id)
  store.teamMembers = store.teamMembers.filter((member) => member.teamId !== id)
  store.teamTasks = store.teamTasks.filter((task) => task.teamId !== id)
  store.teamEvents = store.teamEvents.filter((event) => event.teamId !== id)
  persist()
}
