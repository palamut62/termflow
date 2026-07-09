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
  PaneNode
} from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { profileFor } from '../profiles'
import { computeLayout } from '../autolayout'
import { getLeafTerminalIds, getActiveTerminalId, splitPane, closePane, countLeaves } from '../paneUtils'

const DEFAULT_SIZE = { width: 900, height: 520 } // PRD §10.3.4

interface NewTerminalOpts {
  cwd?: string
  startupCommand?: string
  customShell?: string
  name?: string
  agentRole?: string
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
  restartNode: (nodeId: string) => Promise<void>
  toggleMinimize: (nodeId: string) => void
  toggleMaximize: (nodeId: string) => void
  toggleInfo: (nodeId: string) => void
  renameNode: (nodeId: string, title: string) => void

  addConnection: (source: string, target: string, type: ConnectionType, label?: string, routeOpts?: { triggerPattern?: string; transform?: string; routeBehavior?: 'marker' | 'continuous' | 'disabled'; routeDirection?: 'source_to_target' | 'bidirectional' }) => void
  removeConnection: (id: string) => void

  setLayoutMode: (mode: LayoutMode, vp?: { width: number; height: number }) => void
  applyAutoLayout: (vp: { width: number; height: number }) => void
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
  closePaneInNode: (nodeId: string, terminalId: string) => Promise<void>
  setActivePane: (nodeId: string, terminalId: string) => void

  // Highlight rules (P1-8)
  highlightRules: HighlightRule[]
  loadHighlightRules: () => Promise<void>

  // Git status (P2-9)
  gitStatus: Record<string, { branch: string; dirty: boolean } | null>
  startGitPolling: () => void

  // Recording (P2-10)
  startRecording: (terminalId: string) => void
  stopRecording: (terminalId: string) => Promise<unknown[]>
  saveRecording: (terminalId: string) => Promise<void>

  startRuntimeListeners: () => void
  refreshStats: () => Promise<void>
  persist: () => void
  flushPersist: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let listenersStarted = false
let gitPollingStarted = false
let systemThemeMql: MediaQueryList | null = null

// Apply light/dark/system theme by toggling the root data-theme attribute.
function applyTheme(theme: 'dark' | 'light' | 'system'): void {
  const root = document.documentElement
  const systemDark = (): boolean =>
    window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : true
  const resolve = (): void => {
    const isLight = theme === 'light' || (theme === 'system' && !systemDark())
    if (isLight) root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
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

  // Git status
  gitStatus: {},

  setCanvasSize: (size) => set({ canvasSize: size }),

  loadSettings: async () => {
    const settings = await window.termflow.settings.get()
    set({ settings })
    document.documentElement.style.setProperty('--active-border', settings.activeBorderColor)
    applyTheme(settings.theme)
  },

  updateSettings: async (patch) => {
    const settings = await window.termflow.settings.set(patch)
    set({ settings })
    if (patch.activeBorderColor)
      document.documentElement.style.setProperty('--active-border', settings.activeBorderColor)
    if (patch.theme) applyTheme(settings.theme)
  },

  loadWorkspaces: async () => {
    const workspaces = await window.termflow.workspaces.list()
    set({ workspaces })
    const st = get()
    if (!st.activeWorkspaceId && workspaces.length) await get().openWorkspace(workspaces[0].id)
  },

  openWorkspace: async (id) => {
    // Kill terminals from the previously open workspace before switching.
    const prev = get()
    if (prev.activeWorkspaceId && prev.activeWorkspaceId !== id) {
      for (const t of Object.values(prev.terminals)) window.termflow.pty.kill(t.id)
    }

    const layout = await window.termflow.layout.get(id)
    const terms = await window.termflow.terminals.list(id)
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
      zCounter: layout.nodes.length + 1
    })
    syncAgentRouting(layout.nodes, layout.connections)
    await window.termflow.workspaces.update(id, { lastOpenedAt: new Date().toISOString() })
    await Promise.all([get().loadSnippets(), get().loadHighlightRules()])
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
      args: [],
      cwd,
      status: 'stopped',
      createdAt: ts,
      updatedAt: ts
    }
    // Build the startup command; for AI agents append the bypass-permissions
    // flag so they launch fully authorized when the setting is on.
    let startup = opts?.startupCommand || profile.startupCommand
    if (!opts?.startupCommand && profile.bypassArgs && st.settings.agentAutoApprove) {
      startup = `${profile.startupCommand} ${profile.bypassArgs}`
    }
    session.startupCommand = startup

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
      showInfo: true
    }

    let pid: number | undefined
    try {
      const res = await window.termflow.pty.create(termId, {
        workspaceId: wsId,
        name,
        kind,
        shell: opts?.customShell,
        cwd,
        startupCommand: session.startupCommand
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
      const mode = s.layoutMode === 'manual' ? 'grid' : s.layoutMode
      const computed = computeLayout(mode, all, s.canvasSize, s.connections)
      const nodes = all.map((n) => (computed[n.id] ? { ...n, ...computed[n.id] } : n))
      return {
        terminals: { ...s.terminals, [termId]: persisted },
        nodes,
        activeNodeId: nodeId,
        zCounter: z
      }
    })
    get().persist()
  },

  setActiveNode: (nodeId) => {
    if (!nodeId) {
      set({ activeNodeId: null })
      return
    }
    // Bring the active node to front (PRD: active panel on top).
    const z = get().zCounter + 1
    set((s) => ({
      activeNodeId: nodeId,
      selectedConnectionId: null,
      zCounter: z,
      nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, zIndex: z, status: n.status === 'error' ? 'idle' : n.status } : n))
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
        return get().closePaneInNode(nodeId, activeTermId)
      }
    }

    // Collect all terminalIds from pane tree
    const termIds = node.panes ? getLeafTerminalIds(node.panes) : (node.terminalId ? [node.terminalId] : [])
    if (mode === 'terminate') {
      for (const tid of termIds) {
        window.termflow.pty.kill(tid)
        await window.termflow.terminals.remove(tid)
      }
    } else {
      for (const tid of termIds) {
        await window.termflow.terminals.remove(tid)
      }
    }
    const terminals = { ...st.terminals }
    for (const tid of termIds) delete terminals[tid]
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== nodeId),
      connections: s.connections.filter((c) => c.sourceNodeId !== nodeId && c.targetNodeId !== nodeId),
      terminals,
      activeNodeId: s.activeNodeId === nodeId ? null : s.activeNodeId
    }))
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

    // Create new terminal
    const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId)!
    const profile = profileFor('powershell')
    const newTermId = nanoid()
    const newName = `Terminal ${st.nodes.length + 2}`
    const cwd = ws.path
    const ts = new Date().toISOString()

    const session: TerminalSession = {
      id: newTermId,
      workspaceId: st.activeWorkspaceId!,
      name: newName,
      kind: 'powershell',
      shell: 'powershell.exe',
      args: [],
      cwd,
      status: 'stopped',
      createdAt: ts,
      updatedAt: ts
    }

    try {
      const res = await window.termflow.pty.create(newTermId, { workspaceId: st.activeWorkspaceId!, name: newName, kind: 'powershell', cwd })
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

  closePaneInNode: async (nodeId, terminalId) => {
    const st = get()
    const node = st.nodes.find((n) => n.id === nodeId)
    if (!node?.panes) return

    window.termflow.pty.kill(terminalId)
    await window.termflow.terminals.remove(terminalId)

    const newPane = closePane(node.panes, terminalId)
    const terminals = { ...st.terminals }
    delete terminals[terminalId]

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
