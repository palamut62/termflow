import type { StateCreator } from 'zustand'
import { nanoid } from 'nanoid'
import type {
  TerminalSession,
  CanvasNode,
  ShellKind,
  ProcStats,
  FlowTemplate
} from '../../../../shared/types'
import { profileFor } from '../../profiles'
import { computeLayout } from '../../autolayout'
import { getLeafTerminalIds, getActiveTerminalId, splitPane, closePane, countLeaves } from '../../paneUtils'
import {
  DEFAULT_SIZE,
  parseAgentActivities,
  routeIdleTimers,
  ROUTE_ACTIVE_MS,
  type AgentActivity,
  type NewTerminalOpts
} from '../storeShared'
import { initNotifications, notifyLongCommandDone, notifyError, notifyAgentWaiting } from '../notifications'
import { captureAgentMetric, finishAgentMetric } from '../../agentMetrics'
import type { AppState } from '../appStore'

export interface TerminalSlice {
  terminals: Record<string, TerminalSession>
  procStats: Record<string, ProcStats>
  agentActivities: AgentActivity[]
  detectedAgents: Record<string, { name: string; terminalId: string; nodeId?: string; lastSeenAt: string }>
  termEpoch: Record<string, number> // bump to force xterm remount on restart

  addTerminal: (kind: ShellKind, opts?: NewTerminalOpts) => Promise<void>
  duplicateNode: (nodeId: string) => Promise<void>
  applyFlowTemplate: (template: FlowTemplate) => Promise<void>
  saveFlowTemplate: (name: string) => Promise<{ id?: string; error?: string }>
  sendLogToAgent: (sourceNodeId: string, targetNodeId: string | 'new') => Promise<void>
  closeNode: (nodeId: string, mode: 'terminate' | 'detach') => Promise<void>
  reattachTerminal: (terminalId: string) => Promise<void>
  restartNode: (nodeId: string) => Promise<void>

  // Broadcast (P0-4)
  broadcastEnabled: boolean
  broadcastGroup: string[]
  toggleBroadcast: () => void
  addToBroadcastGroup: (terminalId: string) => void
  removeFromBroadcastGroup: (terminalId: string) => void

  // Pane operations (P0-1)
  splitNode: (nodeId: string, dir: 'horizontal' | 'vertical') => Promise<void>
  closePaneInNode: (nodeId: string, terminalId: string, mode?: 'terminate' | 'detach') => Promise<void>
  setActivePane: (nodeId: string, terminalId: string) => void

  // Recording (P2-10)
  startRecording: (terminalId: string) => void
  stopRecording: (terminalId: string) => Promise<unknown[]>
  saveRecording: (terminalId: string) => Promise<void>
  recordingLimitWarning: { terminalId: string; reason: 'duration' | 'size' } | null
  dismissRecordingLimitWarning: () => void
  clearAgentActivities: () => void

  startRuntimeListeners: () => void
  refreshStats: () => Promise<void>
}

let listenersStarted = false

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set, get) => ({
  terminals: {},
  procStats: {},
  agentActivities: [],
  detectedAgents: {},
  termEpoch: {},

  broadcastEnabled: false,
  broadcastGroup: [],

  recordingLimitWarning: null,

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
      showInfo: get().settings.infoPanelDefaultOpen,
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

  // Duplicate a node: spawn a fresh terminal with the same shell/cwd/startup
  // command as the source node's active terminal (feature: terminal duplicate).
  duplicateNode: async (nodeId) => {
    const st = get()
    const node = st.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const termId = getActiveTerminalId(node.activePaneId, node.panes, node.terminalId)
    const source = termId ? st.terminals[termId] : undefined
    if (!source) return
    await get().addTerminal(source.kind, {
      cwd: source.cwd,
      startupCommand: source.startupCommand,
      customShell: source.shell !== source.kind ? source.shell : undefined,
      args: source.args,
      name: `${node.title} copy`,
      agentRole: node.agentRole,
      env: source.env
    })
  },

  // Instantiate a multi-agent pipeline template: spawns one node per template
  // node (in order) then wires the declared connections between them, using
  // each freshly-created node's id (addTerminal sets activeNodeId to it).
  // (feature: agent flow templates)
  applyFlowTemplate: async (template) => {
    const nodeIds: string[] = []
    for (const n of template.nodes) {
      await get().addTerminal(n.kind, {
        name: n.title,
        agentRole: n.agentRole,
        startupCommand: n.startupCommand
      })
      const created = get().activeNodeId
      if (created) nodeIds.push(created)
    }
    for (const c of template.connections) {
      const source = nodeIds[c.from]
      const target = nodeIds[c.to]
      if (!source || !target) continue
      get().addConnection(source, target, c.connectionType, c.label, {
        triggerPattern: c.triggerPattern,
        routeBehavior: c.routeBehavior,
        routeDirection: c.routeDirection
      })
    }
    get().setLayoutMode('agent_graph', get().canvasSize)
  },

  // Save the currently-open agent nodes (+ connections between them) as a
  // reusable flow template. (feature: agent flow templates)
  saveFlowTemplate: async (name) => {
    const st = get()
    const agentNodes = st.nodes.filter((n) => n.nodeType === 'agent')
    if (agentNodes.length < 2) return { error: 'Select a workspace with at least 2 agent nodes' }
    const indexOf = new Map(agentNodes.map((n, i) => [n.id, i]))
    const nodes = agentNodes.map((n) => {
      const termId = getActiveTerminalId(n.activePaneId, n.panes, n.terminalId)
      const source = termId ? st.terminals[termId] : undefined
      return {
        title: n.title,
        kind: source?.kind ?? 'claude',
        agentRole: n.agentRole,
        startupCommand: source?.startupCommand
      }
    })
    const connections = st.connections
      .filter((c) => indexOf.has(c.sourceNodeId) && indexOf.has(c.targetNodeId))
      .map((c) => ({
        from: indexOf.get(c.sourceNodeId)!,
        to: indexOf.get(c.targetNodeId)!,
        connectionType: c.connectionType,
        label: c.label,
        triggerPattern: c.triggerPattern,
        routeBehavior: c.routeBehavior,
        routeDirection: c.routeDirection
      }))
    return window.termflow.flowTemplates.save(name, nodes, connections)
  },

  // AI log summary: grab a terminal's recent buffer and hand it to an agent
  // (existing node or a freshly spawned one) with a "what happened / error /
  // suggestion" prompt. (feature: AI log summary)
  sendLogToAgent: async (sourceNodeId, targetNodeId) => {
    const st = get()
    const sourceNode = st.nodes.find((n) => n.id === sourceNodeId)
    if (!sourceNode) return
    const sourceTermId = getActiveTerminalId(sourceNode.activePaneId, sourceNode.panes, sourceNode.terminalId)
    if (!sourceTermId) return
    const raw = await window.termflow.pty.buffer(sourceTermId)
    // Strip ANSI escapes + collapse whitespace so it survives as one pty.write line.
    const ESC = String.fromCharCode(27)
    const cleaned = raw
      .split(ESC).join('')
      .replace(/\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const tail = cleaned.slice(-6000)
    const prompt = `Bu bir terminalin (${sourceNode.title}) son çıktısıdır. Ne olduğunu, varsa hatayı ve önerini kısaca özetle: """${tail}"""`

    let targetTermId: string | undefined
    if (targetNodeId === 'new') {
      await get().addTerminal('claude', { name: `${sourceNode.title} — AI Summary`, agentRole: 'Log Summary' })
      const newNodeId = get().activeNodeId
      const newNode = newNodeId ? get().nodes.find((n) => n.id === newNodeId) : undefined
      targetTermId = newNode ? getActiveTerminalId(newNode.activePaneId, newNode.panes, newNode.terminalId) : undefined
      if (targetTermId) {
        const tid = targetTermId
        setTimeout(() => window.termflow.pty.write(tid, prompt + '\r'), 1800)
      }
      return
    }
    const targetNode = st.nodes.find((n) => n.id === targetNodeId)
    if (!targetNode) return
    targetTermId = getActiveTerminalId(targetNode.activePaneId, targetNode.panes, targetNode.terminalId)
    if (targetTermId) window.termflow.pty.write(targetTermId, prompt + '\r')
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

  // ---- Broadcast ----
  toggleBroadcast: () => set((s) => ({ broadcastEnabled: !s.broadcastEnabled })),
  addToBroadcastGroup: (terminalId) =>
    set((s) => ({ broadcastGroup: s.broadcastGroup.includes(terminalId) ? s.broadcastGroup : [...s.broadcastGroup, terminalId] })),
  removeFromBroadcastGroup: (terminalId) =>
    set((s) => ({ broadcastGroup: s.broadcastGroup.filter((tid) => tid !== terminalId) })),

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

  startRuntimeListeners: () => {
    if (listenersStarted) return
    listenersStarted = true
    initNotifications()
    window.termflow.pty.onData((id, data) => {
      const st = get()
      const metricNode = st.nodes.find((node) => node.terminalId === id || (node.panes ? getLeafTerminalIds(node.panes).includes(id) : false))
      if (st.activeWorkspaceId && (metricNode?.agentType || metricNode?.agentRole)) captureAgentMetric(st.activeWorkspaceId, id, metricNode.agentRole || metricNode.title, data)
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
    window.termflow.pty.onExit((id, exitCode, durationMs) => {
      const st = get()
      if (st.activeWorkspaceId) finishAgentMetric(st.activeWorkspaceId, id)
      const t = st.terminals[id]
      if (t) notifyLongCommandDone(id, t.name, exitCode, durationMs)
      // Check if this terminalId belongs to any node (pane-tree aware)
      const nodeWithTerm = st.nodes.find((n) => {
        if (n.terminalId === id) return true
        if (n.panes) return getLeafTerminalIds(n.panes).includes(id)
        return false
      })
      set((s) => {
        const t = s.terminals[id]
        if (!t) return {}
        return {
          terminals: { ...s.terminals, [id]: { ...t, status: 'exited', pid: undefined } },
          nodes: s.nodes.map((n) => (n === nodeWithTerm ? { ...n, status: 'stopped' } : n))
        }
      })
      // Fire matching process_exit task triggers ("when command finishes, run X"). (feature: expanded task triggers)
      if (nodeWithTerm) {
        for (const trigger of get().taskTriggers) {
          if (trigger.kind !== 'process_exit' || !trigger.enabled || trigger.sourceNodeId !== nodeWithTerm.id) continue
          const filter = trigger.exitCodeFilter ?? 'any'
          if (filter === 'zero' && exitCode !== 0) continue
          if (filter === 'nonzero' && exitCode === 0) continue
          void get().runTaskTriggerAction(trigger)
        }
      }
    })
    window.termflow.agent.onRoute((connectionId) => {
      // Pulse the edge 'active' while data flows, then relax back to 'idle'.
      set((s) => {
        const conn = s.connections.find((c) => c.id === connectionId)
        if (!conn || conn.status === 'active') return {}
        return {
          connections: s.connections.map((c) =>
            c.id === connectionId ? { ...c, status: 'active' as const } : c
          )
        }
      })
      const existing = routeIdleTimers.get(connectionId)
      if (existing) clearTimeout(existing)
      routeIdleTimers.set(
        connectionId,
        setTimeout(() => {
          routeIdleTimers.delete(connectionId)
          set((s) => ({
            connections: s.connections.map((c) =>
              c.id === connectionId && c.status === 'active' ? { ...c, status: 'idle' as const } : c
            )
          }))
        }, ROUTE_ACTIVE_MS)
      )
    })
    window.termflow.pty.onActivity((id, error) => {
      if (!error) return
      const t = get().terminals[id]
      if (t) notifyError(id, t.name)
      set((s) => ({
        nodes: s.nodes.map((n) => {
          const isMatch = n.terminalId === id || (n.panes ? getLeafTerminalIds(n.panes).includes(id) : false)
          return isMatch && n.id !== s.activeNodeId ? { ...n, status: 'error' } : n
        })
      }))
    })
    window.termflow.pty.onAwaiting((id) => {
      const t = get().terminals[id]
      if (t) notifyAgentWaiting(id, t.name)
    })
    // OSC 7 cwd tracking: keep the terminal's cwd (and thus the git badge)
    // in sync as the user `cd`s around, without polling. (deep git)
    window.termflow.pty.onCwd((id, cwd) => {
      set((s) => (s.terminals[id] ? { terminals: { ...s.terminals, [id]: { ...s.terminals[id], cwd } } } : {}))
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

  // ---- Recording ----
  startRecording: (terminalId) => window.termflow.recording.start(terminalId),
  stopRecording: (terminalId) => window.termflow.recording.stop(terminalId),
  saveRecording: (terminalId) => window.termflow.recording.save(terminalId),
  dismissRecordingLimitWarning: () => set({ recordingLimitWarning: null }),
  clearAgentActivities: () => set({ agentActivities: [], detectedAgents: {} })
})
