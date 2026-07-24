import type { StateCreator } from 'zustand'
import { nanoid } from 'nanoid'
import type { TerminalSession, WindowDef, ShellKind, ProcStats } from '../../../../shared/types'
import { profileFor } from '../../profiles'
import { getLeafTerminalIds, getActiveTerminalId, splitPane, closePane, countLeaves } from '../../paneUtils'
import {
  AI_BANNER_RE,
  pendingInitialPrompts,
  type NewTerminalOpts
} from '../storeShared'
import { initNotifications, notifyLongCommandDone, notifyError, notifyOutputPattern } from '../notifications'
import type { AppState } from '../appStore'

export interface TerminalSlice {
  terminals: Record<string, TerminalSession>
  procStats: Record<string, ProcStats>
  termEpoch: Record<string, number> // bump to force xterm remount on restart

  addTerminal: (kind: ShellKind, opts?: NewTerminalOpts) => Promise<void>
  duplicateNode: (nodeId: string) => Promise<void>
  closeNode: (nodeId: string, mode: 'terminate' | 'detach') => Promise<void>
  reattachTerminal: (terminalId: string) => Promise<void>
  terminateDetached: (terminalId: string) => Promise<void>
  clearAllDetached: () => Promise<void>
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

  startRuntimeListeners: () => void
  refreshStats: () => Promise<void>
}

let listenersStarted = false
const cwdPersistTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set, get) => ({
  terminals: {},
  procStats: {},
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
    const cleanProviderEnv = opts?.cleanProviderEnv ?? !!profile.startupCommand
    const termId = nanoid()
    const nodeId = nanoid()
    const name = opts?.name || `${profile.label} ${st.nodes.length + 1}`
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
      cleanProviderEnv,
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
    const bypassArgs = opts?.bypassArgs ?? profile.bypassArgs
    const useBypass = !!bypassArgs && st.settings.agentAutoApprove
    const runtimeStartup = useBypass ? `${baseStartup} ${bypassArgs}` : baseStartup

    // 'New Terminal' opens a new WINDOW (tmux window); splitting inside a
    // window is a separate action (Ctrl+Shift+D / Ctrl+Shift+E or the ⋯ menu).
    const node: WindowDef = {
      id: nodeId,
      workspaceId: wsId,
      terminalId: termId,
      panes: { type: 'leaf', terminalId: termId, title: name },
      activePaneId: termId,
      title: name,
      status: 'running',
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
        cleanProviderEnv,
        startupCommand: runtimeStartup
      })
      pid = res.pid
    } catch {
      session.status = 'error'
    }

    // ConPTY can report pid 0 even though creation succeeded and the PTY is
    // usable. Only a rejected create call means startup failed.
    const persisted: TerminalSession = { ...session, pid: pid && pid > 0 ? pid : undefined, status: session.status === 'error' ? 'error' : 'running' }
    await window.termflow.terminals.upsert(persisted)

    // Queue an explicit initial prompt to be typed in once the CLI's startup
    // banner appears (one-shot).
    if (persisted.status === 'running' && opts?.initialPrompt) {
      pendingInitialPrompts.set(termId, opts.initialPrompt)
    }

    set((s) => ({
      terminals: { ...s.terminals, [termId]: persisted },
      nodes: [...s.nodes, node],
      activeNodeId: nodeId
    }))
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
      env: source.env,
      cleanProviderEnv: source.cleanProviderEnv
    })
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
      const index = s.nodes.findIndex((n) => n.id === nodeId)
      const remaining = s.nodes.filter((n) => n.id !== nodeId)
      const gitStatus = { ...s.gitStatus }
      if (mode === 'terminate') for (const tid of termIds) delete gitStatus[tid]
      return {
        nodes: remaining,
        terminals,
        gitStatus,
        zoomedPaneId: null,
        // Closing the selected window falls back to its neighbour, like tmux.
        activeNodeId:
          s.activeNodeId === nodeId
            ? remaining[Math.min(index, remaining.length - 1)]?.id ?? null
            : s.activeNodeId
      }
    })
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
          cleanProviderEnv: terminal.cleanProviderEnv,
          startupCommand: terminal.startupCommand
        })
        nextTerminal = { ...terminal, pid, status: 'running', updatedAt: new Date().toISOString() }
      } catch {
        nextTerminal = { ...terminal, status: 'error', updatedAt: new Date().toISOString() }
      }
    }
    const nodeId = nanoid()
    const node: WindowDef = {
      id: nodeId,
      workspaceId: terminal.workspaceId,
      terminalId,
      panes: { type: 'leaf', terminalId, title: terminal.name },
      activePaneId: terminalId,
      title: terminal.name,
      status: nextTerminal.status === 'running' ? 'running' : 'error'
    }
    set((s) => ({
      terminals: { ...s.terminals, [terminalId]: nextTerminal },
      nodes: [...s.nodes, node],
      activeNodeId: nodeId
    }))
    await window.termflow.terminals.upsert(nextTerminal)
    get().persist()
  },

  // Permanently kill a detached (card-less but still running) session and drop
  // it from the store — the panel's cleanup action so orphaned processes don't
  // linger forever. Only valid for terminals not attached to any node.
  terminateDetached: async (terminalId) => {
    const st = get()
    if (!st.terminals[terminalId]) return
    try {
      window.termflow.pty.kill(terminalId)
      await window.termflow.terminals.remove(terminalId)
    } catch {
      // Process may already be gone; still drop it from state below.
    }
    set((s) => {
      const terminals = { ...s.terminals }
      delete terminals[terminalId]
      const gitStatus = { ...s.gitStatus }
      delete gitStatus[terminalId]
      return { terminals, gitStatus }
    })
    get().persist()
  },

  // Terminate & remove every detached (card-less) session at once — the dock's
  // bulk-cleanup action for when orphaned sessions have piled up.
  clearAllDetached: async () => {
    const st = get()
    const attached = new Set(
      st.nodes.flatMap((n) => (n.panes ? getLeafTerminalIds(n.panes) : n.terminalId ? [n.terminalId] : []))
    )
    const detachedIds = Object.values(st.terminals)
      .filter((t) => !attached.has(t.id))
      .map((t) => t.id)
    if (!detachedIds.length) return
    for (const tid of detachedIds) {
      try {
        window.termflow.pty.kill(tid)
        await window.termflow.terminals.remove(tid)
      } catch {
        // Already gone; still drop from state below.
      }
    }
    set((s) => {
      const terminals = { ...s.terminals }
      const gitStatus = { ...s.gitStatus }
      for (const tid of detachedIds) {
        delete terminals[tid]
        delete gitStatus[tid]
      }
      return { terminals, gitStatus }
    })
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
    const cleanProviderEnv = activeTerminal?.cleanProviderEnv ?? !!profileFor(inheritedKind).startupCommand
    const ts = new Date().toISOString()

    const session: TerminalSession = {
      id: newTermId,
      workspaceId: st.activeWorkspaceId!,
      name: newName,
      kind: inheritedKind,
      shell: activeTerminal?.shell || inheritedKind,
      args: activeTerminal?.args || [],
      cwd,
      cleanProviderEnv,
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
        cwd,
        cleanProviderEnv
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
      // Splitting breaks the zoom (tmux behaviour).
      zoomedPaneId: null,
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
    // Closing a pane breaks the zoom (tmux behaviour).
    set({ zoomedPaneId: null })
    const terminals = { ...st.terminals }
    if (mode === 'terminate') delete terminals[terminalId]

    if (!newPane) {
      // All panes closed — remove node
      set((s) => {
        const gitStatus = { ...s.gitStatus }
        if (mode === 'terminate') delete gitStatus[terminalId]
        const index = s.nodes.findIndex((n) => n.id === nodeId)
        const remaining = s.nodes.filter((n) => n.id !== nodeId)
        return {
          nodes: remaining,
          terminals,
          gitStatus,
          activeNodeId:
            s.activeNodeId === nodeId
              ? remaining[Math.min(index, remaining.length - 1)]?.id ?? null
              : s.activeNodeId
        }
      })
    } else {
      const remainingLeaves = getLeafTerminalIds(newPane)
      set((s) => {
        const gitStatus = { ...s.gitStatus }
        if (mode === 'terminate') delete gitStatus[terminalId]
        return {
        terminals,
        gitStatus,
        nodes: s.nodes.map((n) => n.id === nodeId ? {
          ...n,
          panes: newPane,
          activePaneId: remainingLeaves.includes(node.activePaneId || '') ? node.activePaneId : remainingLeaves[0],
          terminalId: newPane.type === 'leaf' ? newPane.terminalId : n.terminalId
        } : n)
      }})
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
      // Fire the queued initial prompt once the CLI's own startup banner shows
      // up in its output (one-shot per terminal).
      const queuedPrompt = pendingInitialPrompts.get(id)
      if (queuedPrompt && AI_BANNER_RE.test(data)) {
        pendingInitialPrompts.delete(id)
        window.termflow.pty.write(id, `${queuedPrompt}\r`)
      }
    })
    window.termflow.pty.onExit((id, exitCode, durationMs) => {
      const st = get()
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
      if (t) notifyOutputPattern(id, t.name)
    })
    // OSC 7 cwd tracking: keep the terminal's cwd (and thus the git badge)
    // in sync as the user `cd`s around, without polling. (deep git)
    window.termflow.pty.onCwd((id, cwd) => {
      const terminal = get().terminals[id]
      if (!terminal || terminal.cwd === cwd) return
      const updated = { ...terminal, cwd, updatedAt: new Date().toISOString() }
      set((s) => ({ terminals: { ...s.terminals, [id]: updated } }))
      const pending = cwdPersistTimers.get(id)
      if (pending) clearTimeout(pending)
      cwdPersistTimers.set(id, setTimeout(() => {
        cwdPersistTimers.delete(id)
        const latest = get().terminals[id]
        if (latest) void window.termflow.terminals.upsert(latest)
      }, 300))
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
  dismissRecordingLimitWarning: () => set({ recordingLimitWarning: null })
})
