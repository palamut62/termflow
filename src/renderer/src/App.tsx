import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { TerminalSquare, X } from 'lucide-react'
import Sidebar from './components/Sidebar'
import Toolbar from './components/Toolbar'
import StatusBar from './components/StatusBar'
import WorkspaceModal from './components/WorkspaceModal'
import SettingsModal from './components/SettingsModal'
import SnippetModal from './components/SnippetModal'
import AgentActivityPanel from './components/AgentActivityPanel'
import ProjectManifestPanel from './components/ProjectManifestPanel'
import DetachedSessionsPanel from './components/DetachedSessionsPanel'
import DeveloperCenter from './components/DeveloperCenter'
import ConfirmModal from './components/ConfirmModal'
import PromptModal, { type PromptField } from './components/PromptModal'
import CommandPalette, { type PaletteCommand } from './components/CommandPalette'
import CanvasFlow from './canvas/CanvasFlow'
import { useAppStore } from './store/appStore'
import { getActiveTerminalId } from './paneUtils'

function ConnectionInspector(): React.JSX.Element | null {
  const id = useAppStore((s) => s.selectedConnectionId)
  const conn = useAppStore((s) => s.connections.find((c) => c.id === id))
  const nodes = useAppStore((s) => s.nodes)
  const remove = useAppStore((s) => s.removeConnection)
  const select = useAppStore((s) => s.selectConnection)
  if (!conn) return null
  const src = nodes.find((n) => n.id === conn.sourceNodeId)?.title ?? '—'
  const tgt = nodes.find((n) => n.id === conn.targetNodeId)?.title ?? '—'
  return (
    <div className="conn-inspector">
      <div className="ci-head">
        <span>Connection</span>
        <button onClick={() => select(null)}>
          <X size={14} />
        </button>
      </div>
      <div className="info-row">
        <span>Source</span>
        <span className="v">{src}</span>
      </div>
      <div className="info-row">
        <span>Target</span>
        <span className="v">{tgt}</span>
      </div>
      <div className="info-row">
        <span>Type</span>
        <span className="v">{conn.connectionType}</span>
      </div>
      <div className="info-row">
        <span>Label</span>
        <span className="v">{conn.label || '—'}</span>
      </div>
      <div className="info-row">
        <span>Status</span>
        <span className="v">{conn.status}</span>
      </div>
      <div className="info-row">
        <span>Routing</span>
        <span className="v">{conn.routeBehavior ?? 'disabled'}</span>
      </div>
      <div className="info-row">
        <span>Direction</span>
        <span className="v">{conn.routeDirection ?? 'source_to_target'}</span>
      </div>
      {conn.triggerPattern && (
        <div className="info-row">
          <span>Trigger</span>
          <span className="v">{conn.triggerPattern}</span>
        </div>
      )}
      {conn.transform && (
        <div className="info-row">
          <span>Transform</span>
          <span className="v">{conn.transform}</span>
        </div>
      )}
      <button className="btn" style={{ marginTop: 10, width: '100%' }} onClick={() => remove(conn.id)}>
        Delete Connection
      </button>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const loadWorkspaces = useAppStore((s) => s.loadWorkspaces)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const startRuntimeListeners = useAppStore((s) => s.startRuntimeListeners)
  const setCanvasSize = useAppStore((s) => s.setCanvasSize)
  const flushPersist = useAppStore((s) => s.flushPersist)
  const nodes = useAppStore((s) => s.nodes)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const snippets = useAppStore((s) => s.snippets)
  const sshProfiles = useAppStore((s) => s.sshProfiles)
  const projectManifest = useAppStore((s) => s.projectManifest)

  const [showWsModal, setShowWsModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showSnippetModal, setShowSnippetModal] = useState(false)
  const [confirm, setConfirm] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: 'default' | 'danger'
    onConfirm: () => void
  } | null>(null)
  const [prompt, setPrompt] = useState<{
    title: string
    fields: PromptField[]
    submitLabel?: string
    onSubmit: (values: Record<string, string>) => void
  } | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)

  const loadSnippets = useAppStore((s) => s.loadSnippets)
  const loadHighlightRules = useAppStore((s) => s.loadHighlightRules)
  const startGitPolling = useAppStore((s) => s.startGitPolling)

  // Save layout immediately when window closes (before PTYs are killed).
  useEffect(() => {
    const onBeforeUnload = (): void => { flushPersist() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushPersist])

  useEffect(() => {
    loadSettings()
    startRuntimeListeners()
    loadWorkspaces().then(() => {
      loadSnippets()
      loadHighlightRules()
      startGitPolling()
    })
  }, [loadSettings, startRuntimeListeners, loadWorkspaces, loadSnippets, loadHighlightRules, startGitPolling])

  const canvasSize = useCallback(() => {
    const el = canvasRef.current
    return { width: el?.clientWidth ?? 1200, height: el?.clientHeight ?? 800 }
  }, [])

  // Keep the store's canvas size current so auto-arrangement fits the viewport.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const update = (): void => setCanvasSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [setCanvasSize])

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const s = useAppStore.getState
    const cmds: PaletteCommand[] = [
      { id: 'new-cmd', title: 'New Terminal: CMD', run: () => s().addTerminal('cmd') },
      { id: 'new-ps', title: 'New Terminal: PowerShell', run: () => s().addTerminal('powershell') },
      { id: 'new-wsl', title: 'New Terminal: WSL', run: () => s().addTerminal('wsl') },
      { id: 'new-claude', title: 'Open Claude Code', run: () => s().addTerminal('claude') },
      { id: 'new-codex', title: 'Open Codex', run: () => s().addTerminal('codex') },
      { id: 'new-opencode', title: 'Open OpenCode', run: () => s().addTerminal('opencode') },
      ...s().sshProfiles.map((profile) => ({
        id: `ssh:${profile.id}`,
        title: `SSH: ${profile.name} (${profile.user}@${profile.host})`,
        run: () => s().launchSshProfile(profile)
      })),
      ...((s().projectManifest?.tasks ?? []).map((task) => ({
        id: `manifest-task:${task.name}`,
        title: `Task: ${task.name}`,
        run: () => s().runManifestTask(task.name)
      }))),
      {
        id: 'apply-manifest',
        title: 'Apply .termflow.json Manifest',
        run: () => s().applyProjectManifest()
      },
      { id: 'autofit', title: 'Auto Fit Terminals', run: () => s().setLayoutMode('auto_fit', canvasSize()) },
      { id: 'grid', title: 'Layout: Grid', run: () => s().setLayoutMode('grid', canvasSize()) },
      { id: 'focus', title: 'Layout: Focus + Mini', run: () => s().setLayoutMode('focus', canvasSize()) },
      { id: 'agent-graph', title: 'Switch to Agent Graph Layout', run: () => s().setLayoutMode('agent_graph', canvasSize()) },
      {
        id: 'restart',
        title: 'Restart Active Terminal',
        run: () => {
          const a = s().activeNodeId
          if (a) s().restartNode(a)
        }
      },
      {
        id: 'kill-all',
        title: 'Kill All Terminals',
        run: () => {
          setConfirm({
            title: 'Close all terminals',
            message: 'All running terminal panels in this workspace will be terminated.',
            confirmLabel: 'Terminate All',
            tone: 'danger',
            onConfirm: () => s().nodes.slice().forEach((n) => s().closeNode(n.id, 'terminate'))
          })
        }
      },
      { id: 'toggle-broadcast', title: 'Toggle Broadcast Mode', run: () => s().toggleBroadcast() },
      {
        id: 'split-h',
        title: 'Split Active Node Horizontally',
        run: () => {
          const a = s().activeNodeId
          if (a) s().splitNode(a, 'horizontal')
        }
      },
      {
        id: 'split-v',
        title: 'Split Active Node Vertically',
        run: () => {
          const a = s().activeNodeId
          if (a) s().splitNode(a, 'vertical')
        }
      },
      // Add snippets
      ...s().snippets.map((sn) => ({
        id: `snippet:${sn.id}`,
        title: `Snippet: ${sn.name}`,
        run: () => {
          // Quick-run snippet: write to active terminal
          const activeNodeId = s().activeNodeId
          if (!activeNodeId) return
          const node = s().nodes.find((n) => n.id === activeNodeId)
          if (!node) return
          const tid = getActiveTerminalId(node.activePaneId, node.panes, node.terminalId)
          if (tid) {
            if (sn.params.length > 0) {
              setPrompt({
                title: `Snippet: ${sn.name}`,
                submitLabel: 'Run',
                fields: sn.params.map((p) => ({ key: p, label: p, required: true })),
                onSubmit: (values) => {
                  let cmd = sn.command
                  for (const p of sn.params) {
                    cmd = cmd.replace(new RegExp(`\\{\\{${p}\\}\\}`, 'g'), values[p] ?? '')
                  }
                  window.termflow.pty.write(tid, cmd + '\r')
                }
              })
            } else {
              window.termflow.pty.write(tid, sn.command + '\r')
            }
          }
        }
      })),
      { id: 'new-snippet', title: 'Create New Snippet', run: () => setShowSnippetModal(true) },
      { id: 'settings', title: 'Open Settings', run: () => setShowSettings(true) },
      { id: 'new-ws', title: 'Create Workspace', run: () => setShowWsModal(true) }
    ]
    return cmds
  }, [canvasSize, snippets, sshProfiles, projectManifest])

  // Keyboard shortcuts (PRD §21). Ctrl+Alt combos avoid clashing with terminal input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useAppStore.getState()
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowPalette((v) => !v)
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        if (s.activeNodeId) s.splitNode(s.activeNodeId, 'vertical')
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        if (s.activeNodeId) s.splitNode(s.activeNodeId, 'horizontal')
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        s.toggleBroadcast()
      } else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        s.setLayoutMode('auto_fit', canvasSize())
      } else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        s.setLayoutMode('agent_graph', canvasSize())
      } else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        s.addTerminal('cmd')
      } else if (e.key === 'F11') {
        e.preventDefault()
        if (s.activeNodeId) s.toggleMaximize(s.activeNodeId)
      } else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const list = s.nodes
        if (list.length) {
          const i = list.findIndex((n) => n.id === s.activeNodeId)
          s.setActiveNode(list[(i + 1) % list.length].id)
        }
      } else if (e.key === 'Escape') {
        setShowPalette(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canvasSize])

  return (
    <div className="app">
      <Sidebar onNewWorkspace={() => setShowWsModal(true)} />
      <Toolbar
        canvasSize={canvasSize}
        onOpenSettings={() => setShowSettings(true)}
        onOpenPalette={() => setShowPalette(true)}
      />
      <div className="canvas-wrap" ref={canvasRef}>
        <ReactFlowProvider>
          <CanvasFlow />
        </ReactFlowProvider>
        <ConnectionInspector />
        <ProjectManifestPanel />
        <AgentActivityPanel />
        <DetachedSessionsPanel />
        <DeveloperCenter />
        {nodes.length === 0 && (
          <div className="empty-canvas">
            <TerminalSquare size={40} strokeWidth={1.3} />
            <div className="big">{activeWorkspaceId ? 'Empty canvas' : 'Select or create a workspace'}</div>
            <div>{activeWorkspaceId ? 'Add a terminal with "New Terminal"' : ''}</div>
          </div>
        )}
      </div>
      <StatusBar />
      {showWsModal && <WorkspaceModal onClose={() => setShowWsModal(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showSnippetModal && <SnippetModal onClose={() => setShowSnippetModal(false)} />}
      {showPalette && <CommandPalette commands={paletteCommands} onClose={() => setShowPalette(false)} />}
      {confirm && (
        <ConfirmModal
          {...confirm}
          onClose={() => setConfirm(null)}
        />
      )}
      {prompt && (
        <PromptModal
          {...prompt}
          onClose={() => setPrompt(null)}
        />
      )}
    </div>
  )
}
