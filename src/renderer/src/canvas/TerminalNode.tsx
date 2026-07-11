import { memo, useCallback, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Minus,
  Maximize2,
  Minimize2,
  RotateCw,
  Radio,
  CircleStop,
  Save,
  X,
  PanelRightClose,
  PanelRightOpen,
  Bot,
  TerminalSquare,
  AlertTriangle,
  GitBranch
} from 'lucide-react'
import TerminalView from '../components/TerminalView'
import CloseModal from '../components/CloseModal'
import { useAppStore } from '../store/appStore'
import { profileFor } from '../profiles'
import type { PaneNode } from '../../../shared/types'
import { getLeafTerminalIds, countLeaves, setPaneRatio } from '../paneUtils'

function activeTermId(node: { activePaneId?: string; panes?: PaneNode; terminalId?: string }): string | undefined {
  return node.activePaneId || (node.panes ? getLeafTerminalIds(node.panes)[0] : node.terminalId)
}

function InfoArea({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId))
  const termId = node ? activeTermId(node) : undefined
  const terminal = useAppStore((s) => (termId ? s.terminals[termId] : undefined))
  const stats = useAppStore((s) => (termId ? s.procStats[termId] : undefined))
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

const MINW = 420
const MINH = 200

// [class suffix, dirX, dirY] — dir ∈ {-1: top/left edge, 0: none, 1: bottom/right edge}
const HANDLES: [string, number, number][] = [
  ['nw', -1, -1],
  ['n', 0, -1],
  ['ne', 1, -1],
  ['w', -1, 0],
  ['e', 1, 0],
  ['sw', -1, 1],
  ['s', 0, 1],
  ['se', 1, 1]
]

/**
 * Custom resize handles. Uses pointer capture on the handle element so a drag
 * is tracked reliably (independent of React Flow's d3-drag), converting screen
 * deltas to flow coordinates via the current zoom. (user: corner resize)
 */
function ResizeHandles({ nodeId }: { nodeId: string }): React.JSX.Element {
  const updateNode = useAppStore((s) => s.updateNode)
  const tiled = useAppStore((s) => s.layoutMode !== 'manual' && s.layoutMode !== 'agent_graph')
  const resizeFocusedNode = useAppStore((s) => s.resizeFocusedNode)

  const start = useCallback(
    (dirX: number, dirY: number) => (e: React.PointerEvent) => {
      e.stopPropagation()
      e.preventDefault()
      const el = e.currentTarget as HTMLDivElement
      el.setPointerCapture(e.pointerId)
      const st = useAppStore.getState()
      const node = st.nodes.find((n) => n.id === nodeId)
      if (!node) return
      const zoom = st.viewport.zoom || 1
      const startX = e.clientX
      const startY = e.clientY
      const p0 = { ...node.position }
      const s0 = { ...node.size }
      const isTiledDivider = tiled && dirX === 1 && dirY === 0

      const onMove = (ev: PointerEvent): void => {
        const dx = (ev.clientX - startX) / zoom
        const dy = (ev.clientY - startY) / zoom
        if (isTiledDivider) {
          resizeFocusedNode(nodeId, s0.width + dx)
          return
        }
        let x = p0.x
        let y = p0.y
        let width = s0.width
        let height = s0.height
        if (dirX === 1) width = s0.width + dx
        else if (dirX === -1) {
          width = s0.width - dx
          x = p0.x + dx
        }
        if (dirY === 1) height = s0.height + dy
        else if (dirY === -1) {
          height = s0.height - dy
          y = p0.y + dy
        }
        // clamp to minimums, adjusting x/y when dragging top/left edges
        if (width < MINW) {
          if (dirX === -1) x -= MINW - width
          width = MINW
        }
        if (height < MINH) {
          if (dirY === -1) y -= MINH - height
          height = MINH
        }
        updateNode(nodeId, { position: { x, y }, size: { width: Math.round(width), height: Math.round(height) } })
      }
      const onUp = (ev: PointerEvent): void => {
        try {
          el.releasePointerCapture(ev.pointerId)
        } catch {
          /* ignore */
        }
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onUp)
        // Resolve collisions once, on release — stable, single pass (no drift).
        if (isTiledDivider) useAppStore.getState().persist()
        else useAppStore.getState().resolveCollisions(nodeId)
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
    },
    [nodeId, resizeFocusedNode, tiled, updateNode]
  )

  const handles = tiled ? HANDLES.filter(([dir]) => dir === 'e') : HANDLES

  return (
    <>
      {handles.map(([dir, dx, dy]) => (
        <div key={dir} className={`rz rz-${dir} ${tiled ? 'rz-tiled-divider' : ''} nodrag nowheel`} onPointerDown={start(dx, dy)} />
      ))}
    </>
  )
}

function PaneRenderer({ nodeId, pane, path }: { nodeId: string; pane: PaneNode; path: number[] }): React.JSX.Element {
  const activeNodeId = useAppStore(s => s.activeNodeId)
  const active = activeNodeId === nodeId
  const updateNode = useAppStore(s => s.updateNode)

  if (pane.type === 'leaf') {
    const epoch = useAppStore(s => s.termEpoch[pane.terminalId] ?? 0)
    return (
      <div className="pane-leaf nodrag nowheel" key={pane.terminalId}>
        <TerminalView key={`${pane.terminalId}:${epoch}`}
          terminalId={pane.terminalId} active={active} />
      </div>
    )
  }

  // Split pane
  const isHorizontal = pane.dir === 'horizontal'
  const sizeA = `${Math.round(pane.ratio * 100)}%`
  const sizeB = `${Math.round((1 - pane.ratio) * 100)}%`

  const onSplitterDrag = (e: React.PointerEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget as HTMLDivElement
    el.setPointerCapture(e.pointerId)
    const container = el.parentElement!
    const startPos = isHorizontal ? e.clientX : e.clientY
    const totalSize = isHorizontal ? container.clientWidth : container.clientHeight

    const onMove = (ev: PointerEvent): void => {
      const delta = (isHorizontal ? ev.clientX : ev.clientY) - startPos
      const newRatio = pane.ratio + delta / totalSize
      const n = useAppStore.getState().nodes.find(n => n.id === nodeId)
      if (n && n.panes) {
        updateNode(nodeId, { panes: setPaneRatio(n.panes, path, newRatio) })
      }
    }
    const onUp = (ev: PointerEvent): void => {
      try { el.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  return (
    <div className={`pane-split ${isHorizontal ? 'horizontal' : 'vertical'}`}>
      <div className="nodrag nowheel" style={{ [isHorizontal ? 'width' : 'height']: sizeA, overflow: 'hidden' }}>
        <PaneRenderer nodeId={nodeId} pane={pane.a} path={[...path, 0]} />
      </div>
      <div className={`pane-splitter nodrag nowheel ${isHorizontal ? 'h' : 'v'}`} onPointerDown={onSplitterDrag} />
      <div className="nodrag nowheel" style={{ [isHorizontal ? 'width' : 'height']: sizeB, overflow: 'hidden' }}>
        <PaneRenderer nodeId={nodeId} pane={pane.b} path={[...path, 1]} />
      </div>
    </div>
  )
}

function TerminalNodeInner({ id, selected }: NodeProps): React.JSX.Element {
  const node = useAppStore((s) => s.nodes.find((n) => n.id === id))
  const termId = node ? activeTermId(node) : undefined
  const terminal = useAppStore((s) => (termId ? s.terminals[termId] : undefined))
  const terminals = useAppStore((s) => s.terminals)
  const activeNodeId = useAppStore((s) => s.activeNodeId)
  const toggleMinimize = useAppStore((s) => s.toggleMinimize)
  const toggleMaximize = useAppStore((s) => s.toggleMaximize)
  const toggleInfo = useAppStore((s) => s.toggleInfo)
  const restartNode = useAppStore((s) => s.restartNode)
  const closeNode = useAppStore((s) => s.closeNode)
  const renameNode = useAppStore((s) => s.renameNode)
  const updateNode = useAppStore((s) => s.updateNode)
  const closePaneInNode = useAppStore((s) => s.closePaneInNode)
  const setActivePane = useAppStore((s) => s.setActivePane)
  const addToBroadcastGroup = useAppStore((s) => s.addToBroadcastGroup)
  const removeFromBroadcastGroup = useAppStore((s) => s.removeFromBroadcastGroup)
  const startRecording = useAppStore((s) => s.startRecording)
  const stopRecording = useAppStore((s) => s.stopRecording)
  const saveRecording = useAppStore((s) => s.saveRecording)
  const gitStatus = useAppStore((s) => s.gitStatus)
  const broadcastEnabled = useAppStore((s) => s.broadcastEnabled)
  const broadcastGroup = useAppStore((s) => s.broadcastGroup)

  const [editing, setEditing] = useState(false)
  const [closing, setClosing] = useState(false)
  const [recording, setRecording] = useState(false)

  if (!node || !terminal) return <div />

  const active = activeNodeId === id
  const showInfo = node.showInfo && node.size.width > 640 && !node.isMinimized
  const isAgent = node.nodeType === 'agent'
  const hasError = node.status === 'error'
  const isBroadcasting = broadcastEnabled && termId !== undefined && broadcastGroup.includes(termId)

  return (
    <div className="tnode-wrap">
      <div className={`tnode ${active ? 'active' : ''} ${node.isMinimized ? 'minimized' : ''} ${hasError ? 'errored' : ''} ${isBroadcasting ? 'broadcasting' : ''}`}>
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
        {terminal.cwd && gitStatus[termId] && (
          <span className="git-badge" title={`${gitStatus[termId]!.branch}${gitStatus[termId]!.dirty ? ' (dirty)' : ''}`}>
            <GitBranch size={11} />
            {gitStatus[termId]!.branch}
            {gitStatus[termId]!.dirty && <span className="git-dirty">&#9679;</span>}
          </span>
        )}
        <div className="hactions nodrag">
          {termId && (
            <button
              className={`hbtn ${isBroadcasting ? 'active' : ''}`}
              title={isBroadcasting ? 'Remove from broadcast group' : 'Add to broadcast group'}
              onClick={() => {
                if (broadcastGroup.includes(termId)) removeFromBroadcastGroup(termId)
                else addToBroadcastGroup(termId)
              }}
            >
              <Radio size={13} />
            </button>
          )}
          {termId && (
            <button
              className={`hbtn ${recording ? 'active' : ''}`}
              title={recording ? 'Stop recording' : 'Start recording'}
              onClick={async () => {
                if (recording) {
                  await stopRecording(termId)
                  setRecording(false)
                } else {
                  startRecording(termId)
                  setRecording(true)
                }
              }}
            >
              <CircleStop size={13} />
            </button>
          )}
          {termId && (
            <button className="hbtn" title="Save recording" onClick={() => saveRecording(termId)}>
              <Save size={13} />
            </button>
          )}
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
      {node.panes && countLeaves(node.panes) > 1 && (
        <div className="tnode-tabs nodrag">
          {getLeafTerminalIds(node.panes).map(tid => {
            const t = terminals[tid]
            const isActive = (node.activePaneId ?? getLeafTerminalIds(node.panes!)[0]) === tid
            return (
              <div key={tid} className={`tnode-tab ${isActive ? 'active' : ''}`}
                onClick={() => setActivePane(id, tid)}>
                <span>{t?.name || tid.slice(0, 8)}</span>
                {getLeafTerminalIds(node.panes!).length > 1 && (
                  <button className="tab-close" onClick={(e) => { e.stopPropagation(); closePaneInNode(id, tid) }}>&times;</button>
                )}
              </div>
            )
          })}
        </div>
      )}
      </div>
      {!node.isMinimized && (
        <div className="tnode-body">
          <PaneRenderer nodeId={id} pane={node.panes || { type: 'leaf', terminalId: node.terminalId!, title: node.title }} path={[]} />
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
      {active && !node.isMinimized && !node.isMaximized && <ResizeHandles nodeId={id} />}
    </div>
  )
}

export default memo(TerminalNodeInner)
