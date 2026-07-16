import { Cpu, GitBranch, TerminalSquare, Layers, Unplug } from 'lucide-react'
import { useMemo } from 'react'
import { getLeafTerminalIds } from '../paneUtils'
import { useAppStore } from '../store/appStore'

export default function StatusBar(): React.JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const connections = useAppStore((s) => s.connections)
  const terminals = useAppStore((s) => s.terminals)
  const layoutMode = useAppStore((s) => s.layoutMode)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const detectedAgents = useAppStore((s) => s.detectedAgents)
  const ws = workspaces.find((w) => w.id === activeWorkspaceId)
  const running = Object.values(terminals).filter((t) => t.status === 'running').length
  const agentCount = Object.keys(detectedAgents).length
  const detachedCount = useMemo(() => {
    const attached = new Set(
      nodes.flatMap((node) => (node.panes ? getLeafTerminalIds(node.panes) : node.terminalId ? [node.terminalId] : []))
    )
    return Object.values(terminals).filter((terminal) => !attached.has(terminal.id)).length
  }, [nodes, terminals])

  return (
    <div className="statusbar">
      <span className="sb-item">
        <GitBranch size={12} /> {ws?.name ?? 'No workspace'}
      </span>
      <span className="sb-item">
        <TerminalSquare size={12} /> {nodes.length} panel{nodes.length !== 1 ? 's' : ''} · {running} running
      </span>
      {connections.length > 0 && (
        <span className="sb-item">
          <Layers size={12} /> {connections.length} connection{connections.length !== 1 ? 's' : ''}
        </span>
      )}
      {agentCount > 0 && (
        <span className="sb-item">
          <Layers size={12} /> {agentCount} detected agent{agentCount !== 1 ? 's' : ''}
        </span>
      )}
      {detachedCount > 0 && (
        <button
          className="sb-item sb-btn"
          title="Detached sessions"
          aria-label="Toggle detached sessions"
          onClick={() => window.dispatchEvent(new CustomEvent('termflow:toggle-detached'))}
        >
          <Unplug size={12} /> {detachedCount} detached
        </button>
      )}
      <span className="sb-item" style={{ marginLeft: 'auto' }}>
        <Cpu size={12} /> layout: {layoutMode}
      </span>
    </div>
  )
}
