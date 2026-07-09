import { memo, useState } from 'react'
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react'
import {
  Minus,
  Maximize2,
  Minimize2,
  RotateCw,
  X,
  PanelRightClose,
  PanelRightOpen,
  Bot,
  TerminalSquare,
  AlertTriangle
} from 'lucide-react'
import TerminalView from '../components/TerminalView'
import CloseModal from '../components/CloseModal'
import { useAppStore } from '../store/appStore'
import { profileFor } from '../profiles'

function InfoArea({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId))
  const terminal = useAppStore((s) => (node ? s.terminals[node.terminalId] : undefined))
  const stats = useAppStore((s) => (node ? s.procStats[node.terminalId] : undefined))
  const connCount = useAppStore(
    (s) => s.connections.filter((c) => c.sourceNodeId === nodeId || c.targetNodeId === nodeId).length
  )
  if (!node || !terminal) return null
  const isAgent = node.nodeType === 'agent'
  const profile = profileFor(terminal.kind)

  return (
    <div className="tnode-info nodrag nowheel">
      {isAgent ? (
        <>
          <h4>Agent</h4>
          <div className="info-row">
            <span>Role</span>
            <span className="v">{node.agentRole ?? '—'}</span>
          </div>
          <div className="info-row">
            <span>Type</span>
            <span className="v">{profile.label}</span>
          </div>
          <div className="info-row">
            <span>Provider</span>
            <span className="v">{node.agentType ?? '—'}</span>
          </div>
        </>
      ) : (
        <>
          <h4>Process</h4>
          <div className="info-row">
            <span>Shell</span>
            <span className="v">{profile.label}</span>
          </div>
        </>
      )}
      <div className="info-row">
        <span>Status</span>
        <span className="v" style={{ color: statusColor(terminal.status) }}>
          {terminal.status}
        </span>
      </div>
      <div className="info-row">
        <span>PID</span>
        <span className="v">{terminal.pid ?? '—'}</span>
      </div>

      <h4>Performance</h4>
      <div className="info-row">
        <span>CPU</span>
        <span className="v">{stats ? `${stats.cpu}%` : '—'}</span>
      </div>
      <div className="info-row">
        <span>RAM</span>
        <span className="v">{stats ? `${stats.memory} MB` : '—'}</span>
      </div>

      <h4>Context</h4>
      <div className="info-row">
        <span>CWD</span>
        <span className="v">{terminal.cwd}</span>
      </div>
      <div className="info-row">
        <span>Links</span>
        <span className="v">{connCount}</span>
      </div>
    </div>
  )
}

function statusColor(status: string): string {
  if (status === 'running') return 'var(--success)'
  if (status === 'error') return 'var(--danger)'
  if (status === 'exited') return 'var(--warning)'
  return 'var(--text-secondary)'
}

function TerminalNodeInner({ id, selected }: NodeProps): React.JSX.Element {
  const node = useAppStore((s) => s.nodes.find((n) => n.id === id))
  const terminal = useAppStore((s) => (node ? s.terminals[node.terminalId] : undefined))
  const epoch = useAppStore((s) => (node ? s.termEpoch[node.terminalId] ?? 0 : 0))
  const activeNodeId = useAppStore((s) => s.activeNodeId)
  const toggleMinimize = useAppStore((s) => s.toggleMinimize)
  const toggleMaximize = useAppStore((s) => s.toggleMaximize)
  const toggleInfo = useAppStore((s) => s.toggleInfo)
  const restartNode = useAppStore((s) => s.restartNode)
  const closeNode = useAppStore((s) => s.closeNode)
  const renameNode = useAppStore((s) => s.renameNode)
  const updateNode = useAppStore((s) => s.updateNode)

  const [editing, setEditing] = useState(false)
  const [closing, setClosing] = useState(false)

  if (!node || !terminal) return <div />

  const active = activeNodeId === id
  const showInfo = node.showInfo && node.size.width > 640 && !node.isMinimized
  const isAgent = node.nodeType === 'agent'
  const hasError = node.status === 'error'

  return (
    <div className={`tnode ${active ? 'active' : ''} ${node.isMinimized ? 'minimized' : ''} ${hasError ? 'errored' : ''}`}>
      <NodeResizer
        isVisible={selected && !node.isMinimized && !node.isMaximized}
        minWidth={420}
        minHeight={260}
      />
      <Handle type="target" position={Position.Left} />
      <div className="tnode-header">
        {hasError ? (
          <AlertTriangle size={14} color="var(--danger)" />
        ) : isAgent ? (
          <Bot size={14} color="var(--accent)" />
        ) : (
          <TerminalSquare size={14} color="var(--text-muted)" />
        )}
        {editing ? (
          <input
            className="nodrag"
            autoFocus
            defaultValue={node.title}
            onBlur={(e) => {
              renameNode(id, e.target.value || node.title)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            style={{
              background: 'var(--bg-main)',
              border: '1px solid var(--accent)',
              borderRadius: 5,
              color: 'var(--text-primary)',
              fontSize: 12,
              padding: '2px 6px',
              outline: 'none'
            }}
          />
        ) : (
          <span className="title" onDoubleClick={() => setEditing(true)}>
            {node.title}
          </span>
        )}
        {node.agentRole && <span className="kind-tag">{node.agentRole}</span>}
        <span className="kind-tag">{terminal.kind}</span>
        <div className="hactions nodrag">
          <button className="hbtn" title="Info" onClick={() => toggleInfo(id)}>
            {node.showInfo ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
          <button className="hbtn" title="Minimize" onClick={() => toggleMinimize(id)}>
            <Minus size={14} />
          </button>
          <button className="hbtn" title={node.isMaximized ? 'Restore' : 'Maximize'} onClick={() => toggleMaximize(id)}>
            {node.isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button className="hbtn" title="Restart" onClick={() => restartNode(id)}>
            <RotateCw size={13} />
          </button>
          <button className="hbtn danger" title="Close" onClick={() => setClosing(true)}>
            <X size={15} />
          </button>
        </div>
      </div>
      {!node.isMinimized && (
        <div className="tnode-body">
          <div className="tnode-term nodrag nowheel">
            {/* key includes epoch so restart fully remounts xterm (clean screen, Bug #4) */}
            <TerminalView key={`${node.terminalId}:${epoch}`} terminalId={node.terminalId} active={active} />
          </div>
          {showInfo && <InfoArea nodeId={id} />}
        </div>
      )}
      {node.isMinimized && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
          {terminal.status} · pid {terminal.pid ?? '—'} {hasError && '· ⚠ hata'}
        </div>
      )}
      {!node.isMinimized && (
        <div className="tnode-footer">
          <span>{terminal.cwd}</span>
          <span style={{ marginLeft: 'auto', color: statusColor(terminal.status) }}>
            {terminal.status} · pid {terminal.pid ?? '—'}
          </span>
        </div>
      )}
      <Handle type="source" position={Position.Right} />

      {closing && (
        <CloseModal
          name={node.title}
          running={terminal.status === 'running'}
          onClose={() => setClosing(false)}
          onTerminate={() => {
            setClosing(false)
            closeNode(id, 'terminate')
          }}
          onDetach={() => {
            setClosing(false)
            closeNode(id, 'detach')
          }}
        />
      )}
    </div>
  )
}

export default memo(TerminalNodeInner)
