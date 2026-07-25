import { GitBranch, TerminalSquare, TriangleAlert, Unplug } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PtyBackendStatus } from '../../../shared/types'
import { getLeafTerminalIds } from '../paneUtils'
import { useAppStore } from '../store/appStore'
import { prefixLabel } from '../prefixKeys'

export default function StatusBar(): React.JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const terminals = useAppStore((s) => s.terminals)
  const activeNodeId = useAppStore((s) => s.activeNodeId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const prefixPending = useAppStore((s) => s.prefixPending)
  const prefixKey = useAppStore((s) => s.settings.prefixKey)
  const copyModePaneId = useAppStore((s) => s.copyModePaneId)
  const ws = workspaces.find((w) => w.id === activeWorkspaceId)
  // Whether terminals survive an app restart depends on the PTY backend; when
  // the persistent daemon is unavailable the user must know before relying on it.
  const [backend, setBackend] = useState<PtyBackendStatus | null>(null)
  useEffect(() => {
    window.termflow.pty.backendStatus().then(setBackend).catch(() => setBackend(null))
    return window.termflow.pty.onBackendChanged(setBackend)
  }, [])
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
      {prefixPending && (
        <span
          className="sb-item"
          title={`${prefixLabel(prefixKey)} pressed — waiting for a command key (press it again to send it to the terminal)`}
          style={{ fontWeight: 700, color: 'var(--warning)' }}
        >
          PREFIX
        </span>
      )}
      {copyModePaneId && (
        <span
          className="sb-item"
          title="Copy mode — hjkl/arrows move, Space or v selects, Enter or y copies, q or Escape exits"
          style={{ fontWeight: 700, color: 'var(--accent)' }}
        >
          COPY
        </span>
      )}
      {backend?.kind === 'in-process' && (
        <span
          className="sb-item"
          title={`Persistent session daemon unavailable${backend.reason ? ` (${backend.reason})` : ''} — terminals will close when TermFlow quits.`}
          style={{ color: 'var(--warning)' }}
        >
          <TriangleAlert size={12} /> no detach
        </span>
      )}
      <span className="sb-item" style={{ marginLeft: 'auto' }}>
        window: {nodes.find((n) => n.id === activeNodeId)?.title ?? '—'}
      </span>
    </div>
  )
}
