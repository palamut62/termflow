import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type {
  Workspace,
  TerminalSession,
  CanvasNode,
  AgentConnection,
  LayoutMode,
  ConnectionType,
  ShellKind,
  CanvasViewport,
  AppSettings,
  ProcStats,
  Snippet,
  HighlightRule,
  GitStatus,
  PaneNode,
  SshProfile,
  TermflowManifest
} from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { profileFor } from '../profiles'
import { isValidSshProfile } from '../../../shared/validation'
import { computeLayout } from '../autolayout'
import { getLeafTerminalIds, getActiveTerminalId, splitPane, closePane, countLeaves } from '../paneUtils'

const DEFAULT_SIZE = { width: 900, height: 520 } // PRD §10.3.4

interface NewTerminalOpts {
  cwd?: string
  startupCommand?: string
  customShell?: string
  args?: string[]
  name?: string
  agentRole?: string
  env?: Record<string, string>
}

export interface AgentActivity {
  id: string
  terminalId: string
  nodeId?: string
  agentName: string
  kind: 'subagent' | 'task' | 'tool' | 'handoff' | 'status'
  message: string
  createdAt: string
}

interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  terminals: Record<string, TerminalSession>
  nodes: CanvasNode[]
  connections: AgentConnection[]
  activeNodeId: string | null
  selectedConnectionId: string | null
  layoutMode: LayoutMode
  viewport: CanvasViewport
  settings: AppSettings
  procStats: Record<string, ProcStats>
  agentActivities: AgentActivity[]
  detectedAgents: Record<string, { name: string; terminalId: string; nodeId?: string; lastSeenAt: string }>
  termEpoch: Record<string, number> // bump to force xterm remount on restart
  zCounter: number
  canvasSize: { width: number; height: number }
  setCanvasSize: (size: { width: number; height: number }) => void

  loadWorkspaces: () => Promise<void>
  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  openWorkspace: (id: string) => Promise<void>
  createWorkspace: (input: { name: string; path: string; description?: string }) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  renameWorkspace: (id: string, name: string) => Promise<void>

  addTerminal: (kind: ShellKind, opts?: NewTerminalOpts) => Promise<void>
  setActiveNode: (nodeId: string | null) => void
  selectConnection: (id: string | null) => void
  updateNode: (nodeId: string, patch: Partial<CanvasNode>) => void
  closeNode: (nodeId: string, mode: 'terminate' | 'detach') => Promise<void>
  reattachTerminal: (terminalId: string) => Promise<void>
  restartNode: (nodeId: string) => Promise<void>
  toggleMinimize: (nodeId: string) => void
  toggleMaximize: (nodeId: string) => void
  toggleInfo: (nodeId: string) => void
  renameNode: (nodeId: string, title: string) => void

  addConnection: (source: string, target: string, type: ConnectionType, label?: string, routeOpts?: { triggerPattern?: string; transform?: string; routeBehavior?: 'marker' | 'continuous' | 'disabled'; routeDirection?: 'source_to_target' | 'bidirectional' }) => void
  removeConnection: (id: string) => void

  setLayoutMode: (mode: LayoutMode, vp?: { width: number; height: number }) => void
  applyAutoLayout: (vp: { width: number; height: number }) => void
  resizeFocusedNode: (nodeId: string, width: number) => void
  resolveCollisions: (anchorId: string) => void
  setViewport: (vp: CanvasViewport) => void

  // Broadcast (P0-4)
  broadcastEnabled: boolean
  broadcastGroup: string[]
  toggleBroadcast: () => void
  addToBroadcastGroup: (terminalId: string) => void
  removeFromBroadcastGroup: (terminalId: string) => void

  // Snippets (P0-2)
  snippets: Snippet[]
  loadSnippets: () => Promise<void>
  createSnippet: (input: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Snippet>
  updateSnippet: (id: string, patch: Partial<Snippet>) => Promise<void>
  deleteSnippet: (id: string) => Promise<void>

  // Pane operations (P0-1)
  splitNode: (nodeId: string, dir: 'horizontal' | 'vertical') => Promise<void>
  closePaneInNode: (nodeId: string, terminalId: string, mode?: 'terminate' | 'detach') => Promise<void>
  setActivePane: (nodeId: string, terminalId: string) => void

  // Highlight rules (P1-8)
  highlightRules: HighlightRule[]
  loadHighlightRules: () => Promise<void>
  sshProfiles: SshProfile[]
  projectManifest: TermflowManifest | null
  projectManifestApplied: boolean
  loadDeveloperResources: () => Promise<void>
  launchSshProfile: (profile: SshProfile) => Promise<void>
  runManifestTask: (taskName: string) => Promise<void>
  applyProjectManifest: () => Promise<void>
  dismissProjectManifest: () => void

  // Git status (P2-9)
  gitStatus: Record<string, { branch: string; dirty: boolean } | null>
  startGitPolling: () => void

  // Recording (P2-10)
  startRecording: (terminalId: string) => void
  stopRecording: (terminalId: string) => Promise<unknown[]>
  saveRecording: (terminalId: string) => Promise<void>
  recordingLimitWarning: { terminalId: string; reason: 'duration' | 'size' } | null
  dismissRecordingLimitWarning: () => void
  clearAgentActivities: () => void

  startRuntimeListeners: () => void
  refreshStats: () => Promise<void>
  persist: () => void
  flushPersist: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let listenersStarted = false
let gitPollingStarted = false
let systemThemeMql: MediaQueryList | null = null
let workspaceRequest = 0

const AGENT_PATTERNS: { kind: AgentActivity['kind']; re: RegExp; nameGroup?: number; messageGroup?: number }[] = [
  { kind: 'subagent', re: /\b(?:sub-?agent|agent team|team agent)\b[:\s-]*([A-Za-z0-9 _.-]+)?/i, nameGroup: 1 },
  { kind: 'task', re: /\b(?:Task|Todo|Plan|Delegating|Assigned)\b[:\s-]+(.+)/i, messageGroup: 1 },
  { kind: 'tool', re: /\b(?:Tool|Using tool|Running tool|Bash|Edit|Read|Write)\b[:\s-]+(.+)/i, messageGroup: 1 },
  { kind: 'handoff', re: /@@HANDOFF@@([\s\S]*?)@@END@@/i, messageGroup: 1 },
  { kind: 'status', re: /\b(?:started|completed|failed|reviewing|coding|testing|debugging)\b[:\s-]*(.+)?/i, messageGroup: 1 }
]

function parseAgentActivities(
  terminalId: string,
  data: string,
  nodes: CanvasNode[],
  terminals: Record<string, TerminalSession>
): AgentActivity[] {
  const node = nodes.find((n) => n.terminalId === terminalId || (n.panes ? getLeafTerminalIds(n.panes).includes(terminalId) : false))
  const terminal = terminals[terminalId]
  if (!node?.agentType && !node?.agentRole) return []
  const sourceName = node?.agentRole || node?.title || terminal?.name || 'Agent'
  const lines = data
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim())
    .filter(Boolean)
  const events: AgentActivity[] = []

  for (const line of lines.slice(-40)) {
    if (line.startsWith('@@TERMFLOW_EVENT@@')) {
      try {
        const payload = JSON.parse(line.slice('@@TERMFLOW_EVENT@@'.length)) as { kind?: AgentActivity['kind']; name?: string; message?: string }
        if (payload.kind && ['subagent', 'task', 'tool', 'handoff', 'status'].includes(payload.kind)) {
          events.push({ id: nanoid(), terminalId, nodeId: node?.id, agentName: (payload.name || sourceName).slice(0, 60), kind: payload.kind, message: (payload.message || payload.kind).slice(0, 220), createdAt: new Date().toISOString() })
          continue
        }
      } catch {
        // Fall through to conservative text detection.
      }
    }
    if (!/\b(agent|subagent|team|task|todo|tool|handoff|delegat|assigned|started|completed|failed|review|coding|testing|debug)\b|@@HANDOFF@@/i.test(line)) {
      continue
    }
    for (const pattern of AGENT_PATTERNS) {
      const match = pattern.re.exec(line)
      if (!match) continue
      const name = (pattern.nameGroup ? match[pattern.nameGroup] : '')?.trim() || sourceName
      const message = (pattern.messageGroup ? match[pattern.messageGroup] : '')?.trim() || line
      events.push({
        id: nanoid(),
        terminalId,
        nodeId: node?.id,
        agentName: name.slice(0, 60),
        kind: pattern.kind,
        message: message.slice(0, 220),
        createdAt: new Date().toISOString()
      })
      break
    }
  }

  return events
}

// Apply light/dark/system theme by toggling the root data-theme attribute.
function applyTheme(theme: AppSettings['theme'], transparency = useAppStore.getState().settings.transparency): void {
  const root = document.documentElement
  const systemDark = (): boolean =>
    window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : true
  const resolve = (): void => {
    const resolved = theme === 'system' ? (systemDark() ? 'mocha' : 'latte') : theme === 'dark' ? 'mocha' : theme === 'light' ? 'latte' : theme
    const isLight = resolved === 'latte' || resolved === 'matcha'
    root.setAttribute('data-theme', resolved)
    const opacity = Math.max(45, Math.min(100, transparency))
    root.toggleAttribute('data-transparency', opacity < 100)
    root.style.setProperty('--user-opacity', String(opacity / 100))
    // Keep the native Windows titlebar overlay (min/max/close) in sync.
    if (isLight) window.termflow.window.setOverlay('#eaedf3', '#4a5162')
    else window.termflow.window.setOverlay('#20242c', '#a0a7b4')
  }
  if (!systemThemeMql && window.matchMedia) {
    systemThemeMql = window.matchMedia('(prefers-color-scheme: dark)')
    systemThemeMql.addEventListener('change', () => {
      if (useAppStore.getState().settings.theme === 'system') resolve()
    })
  }
  resolve()
}

function syncAgentRouting(nodes: CanvasNode[], connections: AgentConnection[]): void {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const termIds = new Set<string>()
  const grouped = new Map<string, unknown[]>()

  for (const node of nodes) {
    const ids = node.panes ? getLeafTerminalIds(node.panes) : (node.terminalId ? [node.terminalId] : [])
    ids.forEach((id) => termIds.add(id))
  }

  const addRule = (sourceNodeId: string, targetNodeId: string, conn: AgentConnection): void => {
    const sourceNode = nodeById.get(sourceNodeId)
    const targetNode = nodeById.get(targetNodeId)
    if (!sourceNode || !targetNode) return
    const sourceTermId = getActiveTerminalId(sourceNode.activePaneId, sourceNode.panes, sourceNode.terminalId)
    const targetTermIds = targetNode.panes
      ? getLeafTerminalIds(targetNode.panes)
      : (targetNode.terminalId ? [targetNode.terminalId] : [])
    if (!sourceTermId || targetTermIds.length === 0) return
    const rules = grouped.get(sourceTermId) ?? []
    rules.push({
      connectionId: conn.id,
      targetTerminalIds: targetTermIds,
      triggerPattern: conn.triggerPattern || '@@HANDOFF@@([\\s\\S]*?)@@END@@',
      transform: conn.transform,
      routeBehavior: conn.routeBehavior
    })
    grouped.set(sourceTermId, rules)
  }

  for (const conn of connections) {
    if (!conn.isActive || !conn.routeBehavior || conn.routeBehavior === 'disabled') continue
    addRule(conn.sourceNodeId, conn.targetNodeId, conn)
    if (conn.routeDirection === 'bidirectional') addRule(conn.targetNodeId, conn.sourceNodeId, conn)
  }

  for (const id of termIds) window.termflow.agent.setRouting(id, grouped.get(id) ?? [])
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  terminals: {},
  nodes: [],
  connections: [],
  activeNodeId: null,
  selectedConnectionId: null,
  layoutMode: 'manual',
  viewport: { zoom: 1, x: 0, y: 0 },
  settings: { ...DEFAULT_SETTINGS },
  procStats: {},
  agentActivities: [],
  detectedAgents: {},
  termEpoch: {},
  zCounter: 1,
  canvasSize: { width: 1200, height: 800 },

  // Broadcast
  broadcastEnabled: false,
  broadcastGroup: [],

  // Snippets
  snippets: [],

  // Highlight rules
  highlightRules: [],
  sshProfiles: [],
  projectManifest: null,
  projectManifestApplied: false,

  // Git status
  gitStatus: {},

  setCanvasSize: (size) => {
    const st = get()
    if (st.layoutMode === 'manual' || st.layoutMode === 'agent_graph') {
      set({ canvasSize: size })
      return
    }
    const previousFocusWidth = st.activeNodeId
      ? st.nodes.find((n) => n.id === st.activeNodeId)?.size.width
      : undefined
    const focusRatio = previousFocusWidth && st.canvasSize.width > 0
      ? previousFocusWidth / st.canvasSize.width
      : 0.68
    const ordered = st.activeNodeId
      ? [...st.nodes.filter((n) => n.id === st.activeNodeId), ...st.nodes.filter((n) => n.id !== st.activeNodeId)]
      : st.nodes
    const mode = st.activeNodeId && st.nodes.length > 1 ? 'focus' : 'grid'
    const computed = computeLayout(mode, ordered, size, st.connections)
    if (st.activeNodeId && ordered.length > 1) {
      const focusWidth = Math.round(Math.max(size.width * 0.35, Math.min(size.width * 0.7, size.width * focusRatio)))
      const rest = ordered.filter((n) => n.id !== st.activeNodeId)
      const restHeight = (size.height + rest.length - 1) / rest.length
      computed[st.activeNodeId] = { position: { x: 0, y: 0 }, size: { width: focusWidth, height: size.height } }
      rest.forEach((node, index) => {
        computed[node.id] = {
          position: { x: focusWidth - 1, y: Math.round(index * (restHeight - 1)) },
          size: { width: size.width - focusWidth + 1, height: Math.round(restHeight) }
        }
      })
    }
    set({
      canvasSize: size,
      nodes: st.nodes.map((n) => (computed[n.id] ? { ...n, ...computed[n.id] } : n))
    })
  },

  loadSettings: async () => {
    const settings = await window.termflow.settings.get()
    set({ settings })
    document.documentElement.style.setProperty('--active-border', settings.activeBorderColor)
    applyTheme(settings.theme, settings.transparency)
  },

  updateSettings: async (patch) => {
    const settings = await window.termflow.settings.set(patch)
    set({ settings })
    if (patch.activeBorderColor)
      document.documentElement.style.setProperty('--active-border', settings.activeBorderColor)
    if (patch.theme || patch.transparency !== undefined) applyTheme(settings.theme, settings.transparency)
  },

  loadWorkspaces: async () => {
    const workspaces = await window.termflow.workspaces.list()
    set({ workspaces })
    const st = get()
    if (!st.activeWorkspaceId && workspaces.length) await get().openWorkspace(workspaces[0].id)
  },

  openWorkspace: async (id) => {
    const request = ++workspaceRequest
    // Kill terminals from the previously open workspace before switching.
    const prev = get()
    if (prev.activeWorkspaceId && prev.activeWorkspaceId !== id) {
      for (const t of Object.values(prev.terminals)) window.termflow.pty.kill(t.id)
    }

    const layout = await window.termflow.layout.get(id)
    const terms = await window.termflow.terminals.list(id)
    if (request !== workspaceRequest) return
    const terminals: Record<string, TerminalSession> = {}
    for (const t of terms) terminals[t.id] = t

    // Collect all terminalIds from pane trees
    const termIds = new Set<string>()
    for (const node of layout.nodes) {
      if (node.panes) {
        getLeafTerminalIds(node.panes).forEach((tid) => termIds.add(tid))
      } else if (node.terminalId) {
        termIds.add(node.terminalId)
      }
    }

    for (const tid of termIds) {
      if (request !== workspaceRequest) return
      const t = terminals[tid]
      if (!t) {
        // Create a terminal session for this pane if it doesn't exist
        const termSession: TerminalSession = {
          id: tid,
          workspaceId: id,
          name: `Terminal`,
          kind: 'powershell',
          shell: 'powershell.exe',
          args: [],
          cwd: '',
          status: 'stopped',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
        try {
          const { pid } = await window.termflow.pty.create(tid, {
            workspaceId: id,
            name: termSession.name,
            kind: termSession.kind,
            cwd: termSession.cwd
          })
          terminals[tid] = { ...termSession, pid, status: 'running' }
        } catch {
          terminals[tid] = { ...termSession, status: 'error' }
        }
        continue
      }
      try {
        const { pid } = await window.termflow.pty.create(t.id, {
          workspaceId: id,
          name: t.name,
          kind: t.kind,
          shell: t.shell,
          args: t.args,
          cwd: t.cwd,
          env: t.env,
          startupCommand: t.startupCommand
        })
        terminals[t.id] = { ...t, pid, status: 'running' }
      } catch {
        terminals[t.id] = { ...t, status: 'error' }
      }
    }

    if (request !== workspaceRequest) return
    const [snippets, highlightRules, sshProfiles] = await Promise.all([
      window.termflow.snippets.list(id),
      window.termflow.highlightRules.list(id),
      window.termflow.sshProfiles.list(id)
    ])
    if (request !== workspaceRequest) return
    const ws = get().workspaces.find((w) => w.id === id)
    const manifest = ws?.path ? await window.termflow.workspaces.checkManifest(ws.path) as TermflowManifest | null : null
    if (request !== workspaceRequest) return
    set({
      activeWorkspaceId: id,
      nodes: layout.nodes.map((n) => ({ ...n, isMaximized: false })),
      connections: layout.connections,
      layoutMode: layout.layoutMode,
      viewport: layout.viewport,
      terminals,
      activeNodeId: layout.activeNodeId && layout.nodes.some((n) => n.id === layout.activeNodeId)
        ? layout.activeNodeId
        : layout.nodes[0]?.id ?? null,
      selectedConnectionId: null,
      zCounter: layout.nodes.length + 1,
      snippets,
      highlightRules,
      sshProfiles,
      projectManifest: manifest,
      projectManifestApplied: false,
      agentActivities: [],
      detectedAgents: {}
    })
    syncAgentRouting(layout.nodes, layout.connections)
    await window.termflow.workspaces.update(id, { lastOpenedAt: new Date().toISOString() })
  },

  createWorkspace: async (input) => {
    const ws = await window.termflow.workspaces.create(input)
    set((s) => ({ workspaces: [ws, ...s.workspaces] }))
    await get().openWorkspace(ws.id)
  },

  deleteWorkspace: async (id) => {
    const { terminals, activeWorkspaceId } = get()
    if (activeWorkspaceId === id) for (const t of Object.values(terminals)) window.termflow.pty.kill(t.id)
    await window.termflow.workspaces.remove(id)
    const workspaces = await window.termflow.workspaces.list()
    set({ workspaces })
    if (activeWorkspaceId === id) {
      set({ activeWorkspaceId: null, nodes: [], connections: [], terminals: {}, activeNodeId: null })
      if (workspaces.length) await get().openWorkspace(workspaces[0].id)
    }
  },

  renameWorkspace: async (id, name) => {
    await window.termflow.workspaces.update(id, { name })
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)) }))
  },

  addTerminal: async (kind, opts) => {
    const st = get()
    const wsId = st.activeWorkspaceId
    if (!wsId) return
    const ws = st.workspaces.find((w) => w.id === wsId)!
    const profile = profileFor(kind)
    const termId = nanoid()
    const nodeId = nanoid()
    const name = opts?.name || `${opts?.agentRole || profile.label} ${st.nodes.length + 1}`
    const cwd = opts?.cwd || ws.path
    const ts = new Date().toISOString()

    const session: TerminalSession = {
      id: termId,
      workspaceId: wsId,
      name,
      kind,
      shell: opts?.customShell || kind,
      args: opts?.args || [],
      cwd,
      env: opts?.env,
      status: 'stopped',
      createdAt: ts,
      updatedAt: ts
    }
    // Persist only the plain startup command. The permission-bypass flag is
    // NEVER written into the saved session state; it is applied at runtime
    // (spawn time) based on the current agentAutoApprove setting so it cannot
    // silently re-enable itself on reload. (security)
    const baseStartup = opts?.startupCommand || profile.startupCommand
    session.startupCommand = baseStartup
    const useBypass = !opts?.startupCommand && !!profile.bypassArgs && st.settings.agentAutoApprove
    const runtimeStartup = useBypass ? `${profile.startupCommand} ${profile.bypassArgs}` : baseStartup

    const z = st.zCounter + 1
    const node: CanvasNode = {
      id: nodeId,
      workspaceId: wsId,
      terminalId: termId,
      panes: { type: 'leaf', terminalId: termId, title: name },
      activePaneId: termId,
      title: name,
      nodeType: opts?.agentRole ? 'agent' : profile.nodeType,
      agentType: profile.agentType,
      agentRole: opts?.agentRole,
      position: { x: 80, y: 80 },
      size: { ...DEFAULT_SIZE },
      zIndex: z,
      isMinimized: false,
      isMaximized: false,
      status: 'running',
      showInfo: true,
      bypass: useBypass
    }

    let pid: number | undefined
    try {
      const res = await window.termflow.pty.create(termId, {
        workspaceId: wsId,
        name,
        kind,
        shell: opts?.customShell,
        args: opts?.args,
        cwd,
        env: opts?.env,
        startupCommand: runtimeStartup
      })
      pid = res.pid
    } catch {
      session.status = 'error'
    }

    const persisted: TerminalSession = { ...session, pid, status: pid ? 'running' : 'error' }
    await window.termflow.terminals.upsert(persisted)

    set((s) => {
      // Auto-arrange so new terminals never stack; tile them proportionally to
      // the canvas (bigger when few, smaller when many). Manual mode tiles as a
      // grid; an active layout mode re-runs itself. (user request)
      const all = [...s.nodes, node]
      const computed = computeLayout('grid', all, s.canvasSize, s.connections)
      const nodes = all.map((n) => (computed[n.id] ? { ...n, ...computed[n.id] } : n))
      return {
        terminals: { ...s.terminals, [termId]: persisted },
        nodes,
        layoutMode: 'grid',
        activeNodeId: nodeId,
        zCounter: z
      }
    })
    get().persist()
  },

  setActiveNode: (nodeId) => {
    const current = get()
    const isTiled = current.layoutMode !== 'manual' && current.layoutMode !== 'agent_graph'
    if (!isTiled) {
      const z = current.zCounter + 1
      set((s) => ({
        activeNodeId: nodeId,
        selectedConnectionId: null,
        zCounter: nodeId ? z : s.zCounter,
        nodes: nodeId
          ? s.nodes.map((n) => n.id === nodeId ? { ...n, zIndex: z } : n)
          : s.nodes
      }))
      return
    }
    if (nodeId && nodeId === current.activeNodeId) {
      set({ selectedConnectionId: null })
      return
    }
    if (!nodeId) {
      set({ activeNodeId: null, selectedConnectionId: null })
      return
    }
    const st = get()
    const z = st.zCounter + 1
    const ordered = [
      ...st.nodes.filter((n) => n.id === nodeId),
      ...st.nodes.filter((n) => n.id !== nodeId && !n.isMinimized)
    ]
    const computed = computeLayout('focus', ordered, st.canvasSize, st.connections)
    set((s) => ({
      activeNodeId: nodeId,
      selectedConnectionId: null,
      zCounter: z,
      nodes: s.nodes.map((n) => ({
        ...n,
        isMaximized: false,
        ...(computed[n.id] || {}),
        ...(n.id === nodeId ? { zIndex: z, status: n.status === 'error' ? 'idle' as const : n.status } : {})
      }))
    }))
    get().persist()
  },

  selectConnection: (id) => set({ selectedConnectionId: id, activeNodeId: id ? null : get().activeNodeId }),

  updateNode: (nodeId, patch) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }))
    get().persist()
  },

  closeNode: async (nodeId, mode) => {
    const st = get()
    const node = st.nodes.find((n) => n.id === nodeId)
    if (!node) return

    // If node has multiple panes with panes tree, close just the active pane
    if (node.panes && countLeaves(node.panes) > 1) {
      const activeTermId = node.activePaneId || getLeafTerminalIds(node.panes)[0]
      if (activeTermId) {
        return get().closePaneInNode(nodeId, activeTermId, mode)
      }
    }

    // Collect all terminalIds from pane tree
    const termIds = node.panes ? getLeafTerminalIds(node.panes) : (node.terminalId ? [node.terminalId] : [])
    if (mode === 'terminate') {
      for (const tid of termIds) {
        window.termflow.pty.kill(tid)
        await window.termflow.terminals.remove(tid)
      }
    }
    const terminals = { ...st.terminals }
    if (mode === 'terminate') for (const tid of termIds) delete terminals[tid]
    set((s) => {
      const remaining = s.nodes.filter((n) => n.id !== nodeId)
      const computed = computeLayout('grid', remaining, s.canvasSize, s.connections)
      return {
      nodes: remaining.map((n) => ({ ...n, ...(computed[n.id] || {}) })),
      connections: s.connections.filter((c) => c.sourceNodeId !== nodeId && c.targetNodeId !== nodeId),
      terminals,
      activeNodeId: s.activeNodeId === nodeId ? null : s.activeNodeId
    }})
    get().persist()
  },

  reattachTerminal: async (terminalId) => {
    const st = get()
    const terminal = st.terminals[terminalId]
    if (!terminal || !st.activeWorkspaceId || terminal.workspaceId !== st.activeWorkspaceId) return
    let nextTerminal = terminal
    if (terminal.status !== 'running') {
      try {
        const { pid } = await window.termflow.pty.create(terminal.id, {
          workspaceId: terminal.workspaceId,
          name: terminal.name,
          kind: terminal.kind,
          shell: terminal.shell,
          args: terminal.args,
          cwd: terminal.cwd,
          env: terminal.env,
          startupCommand: terminal.startupCommand
        })
        nextTerminal = { ...terminal, pid, status: 'running', updatedAt: new Date().toISOString() }
      } catch {
        nextTerminal = { ...terminal, status: 'error', updatedAt: new Date().toISOString() }
      }
    }
    const nodeId = nanoid()
    const z = st.zCounter + 1
    const node: CanvasNode = {
      id: nodeId,
      workspaceId: terminal.workspaceId,
      terminalId,
      panes: { type: 'leaf', terminalId, title: terminal.name },
      activePaneId: terminalId,
      title: terminal.name,
      nodeType: profileFor(terminal.kind).nodeType,
      position: { x: 36 + st.nodes.length * 24, y: 36 + st.nodes.length * 24 },
      size: DEFAULT_SIZE,
      zIndex: z,
      isMinimized: false,
      isMaximized: false,
      status: nextTerminal.status === 'running' ? 'running' : 'error',
      showInfo: false
    }
    set((s) => ({
      terminals: { ...s.terminals, [terminalId]: nextTerminal },
      nodes: [...s.nodes, node],
      activeNodeId: nodeId,
      zCounter: z
    }))
    await window.termflow.terminals.upsert(nextTerminal)
    get().persist()
  },

  restartNode: async (nodeId) => {
    const st = get()
    const node = st.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const termId = getActiveTerminalId(node.activePaneId, node.panes, node.terminalId)
    if (!termId) return
    const res = await window.termflow.pty.restart(termId)
    if (res) {
      set((s) => ({
        terminals: {
          ...s.terminals,
          [termId]: { ...s.terminals[termId], pid: res.pid, status: 'running' }
        },
        nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, status: 'running' } : n)),
        termEpoch: { ...s.termEpoch, [termId]: (s.termEpoch[termId] ?? 0) + 1 }
      }))
    }
  },

  toggleMinimize: (nodeId) => {
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, isMinimized: !n.isMinimized, isMaximized: false } : n))
    }))
    get().persist()
  },

  toggleMaximize: (nodeId) => {
    const st = get()
    const node = st.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const z = st.zCounter + 1
    if (!node.isMaximized) {
      // "Maximize" = focus layout centered on this node: it becomes large while
      // the others scale down into a mini-panel strip. (user request #5)
      const ordered = [node, ...st.nodes.filter((n) => n.id !== nodeId && !n.isMinimized)]
      const computed = computeLayout('focus', ordered, st.canvasSize, st.connections)
      set((s) => ({
        zCounter: z,
        activeNodeId: nodeId,
        layoutMode: 'focus',
        nodes: s.nodes.map((n) => ({
          ...n,
          isMaximized: n.id === nodeId,
          isMinimized: n.id === nodeId ? false : n.isMinimized,
          zIndex: n.id === nodeId ? z : n.zIndex,
          ...(computed[n.id] || {})
        }))
      }))
    } else {
      // Restore: re-tile everything as a proportional grid.
      const computed = computeLayout('grid', st.nodes, st.canvasSize, st.connections)
      set((s) => ({
        layoutMode: 'grid',
        nodes: s.nodes.map((n) => ({ ...n, isMaximized: false, ...(computed[n.id] || {}) }))
      }))
    }
    get().persist()
  },

  toggleInfo: (nodeId) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, showInfo: !n.showInfo } : n)) }))
    get().persist()
  },

  renameNode: (nodeId, title) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, title } : n)) }))
    get().persist()
  },

  addConnection: (source, target, type, label, routeOpts) => {
    if (source === target) return
    const st = get()
    if (!st.activeWorkspaceId) return
    // avoid duplicate identical edges
    if (st.connections.some((c) => c.sourceNodeId === source && c.targetNodeId === target && c.connectionType === type))
      return
    const conn: AgentConnection = {
      id: nanoid(),
      workspaceId: st.activeWorkspaceId,
      sourceNodeId: source,
      targetNodeId: target,
      connectionType: type,
      label,
      isActive: true,
      status: 'idle',
      triggerPattern: routeOpts?.triggerPattern,
      transform: routeOpts?.transform,
      routeBehavior: routeOpts?.routeBehavior || 'disabled',
      routeDirection: routeOpts?.routeDirection || 'source_to_target'
    }

    const nextConnections = [...st.connections, conn]
    syncAgentRouting(st.nodes, nextConnections)
    set({ connections: nextConnections, selectedConnectionId: conn.id })
    get().persist()
  },

  removeConnection: (id) => {
    const st = get()
    const connections = st.connections.filter((c) => c.id !== id)
    syncAgentRouting(st.nodes, connections)
    set({
      connections,
      selectedConnectionId: st.selectedConnectionId === id ? null : st.selectedConnectionId
    })
    get().persist()
  },

  setLayoutMode: (mode, vp) => {
    set({ layoutMode: mode })
    if (mode !== 'manual' && vp) get().applyAutoLayout(vp)
    else get().persist()
  },

  applyAutoLayout: (vp) => {
    const st = get()
    if (st.layoutMode === 'manual') return
    const computed = computeLayout(st.layoutMode, st.nodes, vp, st.connections)
    set((s) => ({
      nodes: s.nodes.map((n) => (computed[n.id] ? { ...n, ...computed[n.id], isMaximized: false } : n))
    }))
    get().persist()
  },

  resizeFocusedNode: (nodeId, requestedWidth) => {
    const st = get()
    const active = st.nodes.find((n) => n.id === nodeId)
    const rest = st.nodes.filter((n) => n.id !== nodeId && !n.isMinimized)
    if (!active || !rest.length) return

    const minActiveWidth = Math.min(280, Math.round(st.canvasSize.width * 0.35))
    const minRestWidth = Math.min(240, Math.round(st.canvasSize.width * 0.3))
    const width = Math.round(Math.max(minActiveWidth, Math.min(requestedWidth, st.canvasSize.width - minRestWidth)))
    const restWidth = st.canvasSize.width - width + 1
    const restHeight = (st.canvasSize.height + rest.length - 1) / rest.length

    set((s) => ({
      nodes: s.nodes.map((n) => {
        if (n.id === nodeId) return { ...n, position: { x: 0, y: 0 }, size: { width, height: st.canvasSize.height } }
        const index = rest.findIndex((item) => item.id === n.id)
        if (index === -1) return n
        return {
          ...n,
          position: { x: width - 1, y: Math.round(index * (restHeight - 1)) },
          size: { width: restWidth, height: Math.round(restHeight) }
        }
      })
    }))
  },

  // Push neighbours out of the way so a resized/dragged node never overlaps
  // another; the anchor stays put and everything else slides to fit. (user)
  resolveCollisions: (anchorId) => {
    const GAP = 16
    const nodes = get().nodes.map((n) => ({
      ...n,
      position: { ...n.position },
      size: { ...n.size }
    }))
    const anchor = nodes.find((n) => n.id === anchorId)
    if (!anchor) return
    const overlaps = (a: CanvasNode, b: CanvasNode): boolean =>
      a.position.x < b.position.x + b.size.width + GAP &&
      a.position.x + a.size.width + GAP > b.position.x &&
      a.position.y < b.position.y + b.size.height + GAP &&
      a.position.y + a.size.height + GAP > b.position.y

    // Only push nodes that overlap the anchor, away from the anchor, once.
    // Direction follows each node's current side (by centre) so nothing jumps
    // across the anchor; clamp to >= 0 so panels never fly off-canvas.
    const acx = anchor.position.x + anchor.size.width / 2
    const acy = anchor.position.y + anchor.size.height / 2
    let changed = false
    for (const other of nodes) {
      if (other.id === anchorId || other.isMinimized || other.isMaximized) continue
      if (!overlaps(anchor, other)) continue
      const dx = other.position.x + other.size.width / 2 - acx
      const dy = other.position.y + other.size.height / 2 - acy
      if (Math.abs(dx) >= Math.abs(dy)) {
        other.position.x =
          dx >= 0 ? anchor.position.x + anchor.size.width + GAP : anchor.position.x - other.size.width - GAP
      } else {
        other.position.y =
          dy >= 0 ? anchor.position.y + anchor.size.height + GAP : anchor.position.y - other.size.height - GAP
      }
      other.position.x = Math.max(0, other.position.x)
      other.position.y = Math.max(0, other.position.y)
      changed = true
    }
    if (changed) {
      set({ nodes })
      get().persist()
    }
  },

  setViewport: (vp) => set({ viewport: vp }),

  startRuntimeListeners: () => {
    if (listenersStarted) return
    listenersStarted = true
    window.termflow.pty.onData((id, data) => {
      const st = get()
      const events = parseAgentActivities(id, data, st.nodes, st.terminals)
      if (!events.length) return
      set((s) => {
        const detectedAgents = { ...s.detectedAgents }
        for (const event of events) {
          detectedAgents[`${event.terminalId}:${event.agentName}`] = {
            name: event.agentName,
            terminalId: event.terminalId,
            nodeId: event.nodeId,
            lastSeenAt: event.createdAt
          }
        }
        const existingKeys = new Set(s.agentActivities.slice(0, 30).map((event) => `${event.terminalId}:${event.kind}:${event.message}`))
        const uniqueEvents = events.filter((event) => !existingKeys.has(`${event.terminalId}:${event.kind}:${event.message}`))
        if (!uniqueEvents.length) return s
        return {
          detectedAgents,
          agentActivities: [...uniqueEvents, ...s.agentActivities].slice(0, 120)
        }
      })
    })
    window.termflow.pty.onExit((id) => {
      set((s) => {
        const t = s.terminals[id]
        if (!t) return {}
        // Check if this terminalId belongs to any node (pane-tree aware)
        const nodeWithTerm = s.nodes.find((n) => {
          if (n.terminalId === id) return true
          if (n.panes) return getLeafTerminalIds(n.panes).includes(id)
          return false
        })
        return {
          terminals: { ...s.terminals, [id]: { ...t, status: 'exited', pid: undefined } },
          nodes: s.nodes.map((n) => (n === nodeWithTerm ? { ...n, status: 'stopped' } : n))
        }
      })
    })
    window.termflow.pty.onActivity((id, error) => {
      if (!error) return
      set((s) => ({
        nodes: s.nodes.map((n) => {
          const isMatch = n.terminalId === id || (n.panes ? getLeafTerminalIds(n.panes).includes(id) : false)
          return isMatch && n.id !== s.activeNodeId ? { ...n, status: 'error' } : n
        })
      }))
    })
    window.termflow.recording.onLimit((id, reason) => {
      set({ recordingLimitWarning: { terminalId: id, reason } })
    })
    // Poll process CPU/RAM. Large workspaces need a slower cadence to avoid UI stalls.
    const poll = (): void => {
      get().refreshStats()
      const count = Object.keys(get().terminals).length
      setTimeout(poll, count > 8 ? 6000 : 2500)
    }
    setTimeout(poll, 1500)
  },

  refreshStats: async () => {
    try {
      const procStats = await window.termflow.proc.stats()
      set({ procStats })
    } catch {
      /* ignore */
    }
  },

  // ---- Broadcast ----
  toggleBroadcast: () => set((s) => ({ broadcastEnabled: !s.broadcastEnabled })),
  addToBroadcastGroup: (terminalId) =>
    set((s) => ({ broadcastGroup: s.broadcastGroup.includes(terminalId) ? s.broadcastGroup : [...s.broadcastGroup, terminalId] })),
  removeFromBroadcastGroup: (terminalId) =>
    set((s) => ({ broadcastGroup: s.broadcastGroup.filter((tid) => tid !== terminalId) })),

  // ---- Snippets ----
  loadSnippets: async () => {
    const wsId = get().activeWorkspaceId
    const snippets = await window.termflow.snippets.list(wsId || undefined)
    set({ snippets })
  },

  createSnippet: async (input) => {
    const snippet = await window.termflow.snippets.create(input)
    set((s) => ({ snippets: [...s.snippets, snippet] }))
    return snippet
  },

  updateSnippet: async (id, patch) => {
    await window.termflow.snippets.update(id, patch)
    set((s) => ({ snippets: s.snippets.map((sn) => (sn.id === id ? { ...sn, ...patch, updatedAt: new Date().toISOString() } : sn)) }))
  },

  deleteSnippet: async (id) => {
    await window.termflow.snippets.remove(id)
    set((s) => ({ snippets: s.snippets.filter((sn) => sn.id !== id) }))
  },

  // ---- Pane Operations ----
  splitNode: async (nodeId, dir) => {
    const st = get()
    const node = st.nodes.find((n) => n.id === nodeId)
    if (!node) return

    const activeTermId = node.activePaneId || (node.panes ? getLeafTerminalIds(node.panes)[0] : node.terminalId)
    if (!activeTermId) return

    const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)!
    const activeTerminal = st.terminals[activeTermId]
    const newTermId = nanoid()
    const inheritedKind = activeTerminal?.kind ?? 'cmd'
    const newName = `${activeTerminal?.name || 'Terminal'} split`
    const cwd = activeTerminal?.cwd || ws.path
    const ts = new Date().toISOString()

    const session: TerminalSession = {
      id: newTermId,
      workspaceId: st.activeWorkspaceId!,
      name: newName,
      kind: inheritedKind,
      shell: activeTerminal?.shell || inheritedKind,
      args: activeTerminal?.args || [],
      cwd,
      status: 'stopped',
      createdAt: ts,
      updatedAt: ts
    }

    try {
      const res = await window.termflow.pty.create(newTermId, {
        workspaceId: st.activeWorkspaceId!,
        name: newName,
        kind: inheritedKind,
        shell: activeTerminal?.shell,
        args: activeTerminal?.args,
        cwd
      })
      session.pid = res.pid
      session.status = 'running'
    } catch {
      session.status = 'error'
    }
    await window.termflow.terminals.upsert(session)

    const currentPane = node.panes || { type: 'leaf' as const, terminalId: node.terminalId!, title: node.title }
    const existingTitle = getLeafTerminalIds(currentPane).includes(activeTermId) ? (get().terminals[activeTermId]?.name || node.title) : node.title
    const newPane = splitPane(currentPane, activeTermId, dir === 'vertical' ? 'horizontal' : 'vertical', existingTitle, newTermId, newName)

    set((s) => ({
      terminals: { ...s.terminals, [newTermId]: session },
      nodes: s.nodes.map((n) => n.id === nodeId ? { ...n, panes: newPane, activePaneId: newTermId } : n)
    }))
    get().persist()
  },

  closePaneInNode: async (nodeId, terminalId, mode = 'terminate') => {
    const st = get()
    const node = st.nodes.find((n) => n.id === nodeId)
    if (!node?.panes) return

    if (mode === 'terminate') {
      window.termflow.pty.kill(terminalId)
      await window.termflow.terminals.remove(terminalId)
    }

    const newPane = closePane(node.panes, terminalId)
    const terminals = { ...st.terminals }
    if (mode === 'terminate') delete terminals[terminalId]

    if (!newPane) {
      // All panes closed — remove node
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== nodeId),
        connections: s.connections.filter((c) => c.sourceNodeId !== nodeId && c.targetNodeId !== nodeId),
        terminals,
        activeNodeId: s.activeNodeId === nodeId ? null : s.activeNodeId
      }))
    } else {
      const remainingLeaves = getLeafTerminalIds(newPane)
      set((s) => ({
        terminals,
        nodes: s.nodes.map((n) => n.id === nodeId ? {
          ...n,
          panes: newPane,
          activePaneId: remainingLeaves.includes(node.activePaneId || '') ? node.activePaneId : remainingLeaves[0],
          terminalId: newPane.type === 'leaf' ? newPane.terminalId : n.terminalId
        } : n)
      }))
    }
    get().persist()
  },

  setActivePane: (nodeId, terminalId) => {
    set((s) => ({ nodes: s.nodes.map((n) => n.id === nodeId ? { ...n, activePaneId: terminalId } : n) }))
    get().persist()
  },

  // ---- Highlight Rules ----
  loadHighlightRules: async () => {
    const wsId = get().activeWorkspaceId
    const highlightRules = await window.termflow.highlightRules.list(wsId || undefined)
    set({ highlightRules })
  },

  loadDeveloperResources: async () => {
    const wsId = get().activeWorkspaceId
    if (!wsId) {
      set({ sshProfiles: [] })
      return
    }
    const sshProfiles = await window.termflow.sshProfiles.list(wsId)
    set({ sshProfiles })
  },

  launchSshProfile: async (profile) => {
    if (!isValidSshProfile(profile)) throw new Error('Invalid SSH profile')
    const args: string[] = []
    if (profile.port && profile.port !== 22) args.push('-p', String(profile.port))
    if (profile.keyPath) args.push('-i', profile.keyPath)
    if (profile.jumpHost) args.push('-J', profile.jumpHost)
    args.push(`${profile.user}@${profile.host}`)
    await get().addTerminal('ssh', {
      name: `SSH: ${profile.name}`,
      args
    })
  },

  runManifestTask: async (taskName) => {
    const st = get()
    const task = st.projectManifest?.tasks?.find((t) => t.name === taskName)
    const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)
    if (!task || !ws) return
    await get().addTerminal(task.shell ?? 'cmd', {
      name: task.name,
      cwd: task.cwd || ws.path,
      startupCommand: task.command
    })
  },

  applyProjectManifest: async () => {
    const st = get()
    const manifest = st.projectManifest
    const wsId = st.activeWorkspaceId
    if (!manifest || !wsId) return

    const existingEnv = await window.termflow.envVars.list(wsId)
    const existingEnvKeys = new Set(existingEnv.map((item) => item.key.toUpperCase()))
    for (const item of manifest.env ?? []) {
      if (!item.key.trim()) continue
      if (existingEnvKeys.has(item.key.trim().toUpperCase())) continue
      await window.termflow.envVars.create({
        workspaceId: wsId,
        key: item.key.trim(),
        value: item.value ?? '',
        masked: item.masked ?? true
      })
    }

    const existingSnippetNames = new Set(st.snippets.map((item) => item.name.toLowerCase()))
    for (const sn of manifest.snippets ?? []) {
      if (!sn.name.trim() || !sn.command.trim()) continue
      if (existingSnippetNames.has(sn.name.trim().toLowerCase())) continue
      const params = [...sn.command.matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)].map((m) => m[1])
      await get().createSnippet({
        workspaceId: sn.scope === 'global' ? null : wsId,
        name: sn.name.trim(),
        command: sn.command,
        params: [...new Set(params)],
        scope: sn.scope ?? 'workspace'
      })
    }

    const existingAgentNames = new Set(st.nodes.map((node) => node.title.toLowerCase()))
    for (const agent of manifest.agents ?? []) {
      if (existingAgentNames.has(agent.name.toLowerCase())) continue
      await get().addTerminal(agent.kind ?? 'claude', {
        name: agent.name,
        agentRole: agent.role,
        startupCommand: agent.command
      })
    }

    set({ projectManifestApplied: true })
    await Promise.all([get().loadDeveloperResources(), get().loadSnippets()])
  },

  dismissProjectManifest: () => set({ projectManifest: null, projectManifestApplied: false }),

  // ---- Git Status ----
  startGitPolling: () => {
    if (gitPollingStarted) return
    gitPollingStarted = true
    const poll = async (): Promise<void> => {
      const st = get()
      if (!st.activeWorkspaceId) return
      const seen = new Set<string>()
      for (const node of st.nodes) {
        const termIds = node.panes ? getLeafTerminalIds(node.panes) : (node.terminalId ? [node.terminalId] : [])
        for (const tid of termIds) {
          if (seen.has(tid)) continue
          seen.add(tid)
          const t = st.terminals[tid]
          if (t?.cwd) {
            try {
              const status = await window.termflow.git.status(t.cwd)
              if (status) set((s) => ({ gitStatus: { ...s.gitStatus, [tid]: status } }))
            } catch { /* ignore */ }
          }
        }
      }
    }
    poll()
    const schedule = (): void => {
      const count = Object.keys(get().terminals).length
      setTimeout(async () => {
        await poll()
        schedule()
      }, count > 8 ? 30000 : 10000)
    }
    schedule()
  },

  // ---- Recording ----
  startRecording: (terminalId) => window.termflow.recording.start(terminalId),
  stopRecording: (terminalId) => window.termflow.recording.stop(terminalId),
  saveRecording: (terminalId) => window.termflow.recording.save(terminalId),
  recordingLimitWarning: null,
  dismissRecordingLimitWarning: () => set({ recordingLimitWarning: null }),
  clearAgentActivities: () => set({ agentActivities: [], detectedAgents: {} }),

  persist: () => {
    const st = get()
    if (!st.activeWorkspaceId) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => get().flushPersist(), 400)
  },

  flushPersist: () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const s = get()
    if (!s.activeWorkspaceId) return
    window.termflow.layout.save({
      workspaceId: s.activeWorkspaceId,
      nodes: s.nodes,
      connections: s.connections,
      layoutMode: s.layoutMode,
      viewport: s.viewport,
      activeNodeId: s.activeNodeId || undefined
    })
  }
}))
