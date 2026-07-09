import { Cpu, GitBranch, TerminalSquare, Layers } from 'lucide-react'
import { useAppStore } from '../store/appStore'

export default function StatusBar(): React.JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const connections = useAppStore((s) => s.connections)
  const terminals = useAppStore((s) => s.terminals)
  const layoutMode = useAppStore((s) => s.layoutMode)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const ws = workspaces.find((w) => w.id === activeWorkspaceId)
  const running = Object.values(terminals).filter((t) => t.status === 'running').length

  return (
    <div className="statusbar">
      <span className="sb-item">
        <GitBranch size={12} /> {ws?.name ?? 'No workspace'}
      </span>
      <span className="sb-item">
        <TerminalSquare size={12} /> {nodes.length} panel{nodes.length !== 1 ? 's' : ''} · {running} running
      </span>
      <span className="sb-item">
        <Layers size={12} /> {connections.length} connection{connections.length !== 1 ? 's' : ''}
      </span>
      <span className="sb-item" style={{ marginLeft: 'auto' }}>
        <Cpu size={12} /> layout: {layoutMode}
      </span>
    </div>
  )
}
