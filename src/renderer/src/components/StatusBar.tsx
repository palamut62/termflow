import { GitBranch, TerminalSquare, Unplug } from 'lucide-react'
import { useMemo } from 'react'
import { getLeafTerminalIds } from '../paneUtils'
import { useAppStore } from '../store/appStore'

export default function StatusBar(): React.JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const terminals = useAppStore((s) => s.terminals)
  const activeNodeId = useAppStore((s) => s.activeNodeId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const ws = workspaces.find((w) => w.id === activeWorkspaceId)
  const running = Object.values(terminals).filter((t) => t.status === 'running').length
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
        <TerminalSquare size={12} /> {nodes.length} window{nodes.length !== 1 ? 's' : ''} · {running} running
      </span>
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
        window: {nodes.find((n) => n.id === activeNodeId)?.title ?? '—'}
      </span>
    </div>
  )
}
