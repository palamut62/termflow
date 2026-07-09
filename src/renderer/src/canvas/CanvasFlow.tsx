import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  type OnConnect,
  type NodeChange,
  type NodeProps
} from '@xyflow/react'
import TerminalNode from './TerminalNode'
import ConnectionModal from '../components/ConnectionModal'
import { useAppStore } from '../store/appStore'
import type { ConnectionType } from '../../../shared/types'

const nodeTypes: NodeTypes = { terminal: TerminalNode as unknown as React.ComponentType<NodeProps> }

const CONN_COLORS: Record<string, string> = {
  control: '#2f80ff',
  data: '#3fb950',
  log: '#a0a7b4',
  error: '#ff4d4f',
  dependency: '#b48ead',
  parent_child: '#f6c343',
  manual: '#6f7685',
  trigger: '#f0803c'
}

export default function CanvasFlow(): React.JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const connections = useAppStore((s) => s.connections)
  const selectedConnectionId = useAppStore((s) => s.selectedConnectionId)
  const snapToGrid = useAppStore((s) => s.settings.snapToGrid)
  const showMinimap = useAppStore((s) => s.settings.minimap)
  const setActiveNode = useAppStore((s) => s.setActiveNode)
  const selectConnection = useAppStore((s) => s.selectConnection)
  const updateNode = useAppStore((s) => s.updateNode)
  const addConnection = useAppStore((s) => s.addConnection)
  const removeConnection = useAppStore((s) => s.removeConnection)
  const setViewport = useAppStore((s) => s.setViewport)
  const wrapRef = useRef<HTMLDivElement>(null)
  const activeNodeId = useAppStore((s) => s.activeNodeId)
  const [pending, setPending] = useState<{ source: string; target: string } | null>(null)

  const rfNodes: Node[] = useMemo(() => {
    return nodes.map((n) => ({
      id: n.id,
      type: 'terminal',
      position: n.position,
      data: {},
      width: n.size.width,
      height: n.isMinimized ? 32 : n.size.height,
      zIndex: n.zIndex,
      selected: n.id === activeNodeId
    }))
  }, [nodes, activeNodeId])

  const rfEdges: Edge[] = useMemo(
    () =>
      connections.map((c) => ({
        id: c.id,
        source: c.sourceNodeId,
        target: c.targetNodeId,
        label: c.label || c.connectionType,
        animated: c.status === 'active',
        selected: c.id === selectedConnectionId,
        style: {
          stroke: CONN_COLORS[c.connectionType] ?? '#6f7685',
          strokeWidth: c.id === selectedConnectionId ? 3 : 2
        },
        labelStyle: { fill: '#e8eaf0', fontSize: 10 },
        labelBgStyle: { fill: '#20242c' },
        markerEnd: { type: 'arrowclosed' as any, color: CONN_COLORS[c.connectionType] ?? '#6f7685' }
      })),
    [connections, selectedConnectionId]
  )

  // Live drag & resize: apply every position/dimension change to the store so
  // the controlled node follows the cursor (fixes teleport-on-drop). (Bug #2)
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const ch of changes) {
        if (ch.type === 'position' && ch.position) {
          updateNode(ch.id, { position: ch.position })
          // On drop, slide neighbours out so panels never overlap.
          if (ch.dragging === false) useAppStore.getState().resolveCollisions(ch.id)
        } else if (ch.type === 'dimensions' && (ch as any).dimensions) {
          const d = (ch as any).dimensions
          updateNode(ch.id, { size: { width: d.width, height: d.height } })
        } else if (ch.type === 'select' && ch.selected) {
          setActiveNode(ch.id)
        }
      }
    },
    [updateNode, setActiveNode]
  )

  const onConnect: OnConnect = useCallback((params) => {
    if (!params.source || !params.target || params.source === params.target) return
    setPending({ source: params.source, target: params.target })
  }, [])

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={(_e, n) => setActiveNode(n.id)}
        onEdgeClick={(_e, edge) => selectConnection(edge.id)}
        onEdgeDoubleClick={(_e, edge) => {
          if (window.confirm('Bağlantıyı sil?')) removeConnection(edge.id)
        }}
        onPaneClick={() => {
          setActiveNode(null)
          selectConnection(null)
        }}
        onMoveEnd={(_e, vp) => setViewport({ zoom: vp.zoom, x: vp.x, y: vp.y })}
        minZoom={0.2}
        maxZoom={2}
        snapToGrid={snapToGrid}
        snapGrid={[22, 22]}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        defaultViewport={{ x: 0, y: 0, zoom: 0.85 }}
        deleteKeyCode={null}
        nodesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#2a2f3a" />
        <Controls showInteractive={false} />
        {showMinimap && (
          <MiniMap
            pannable
            zoomable
            nodeColor="#2f80ff"
            maskColor="rgba(17,19,24,0.7)"
            style={{ background: '#1a1b20', border: '1px solid #2f3440' }}
          />
        )}
      </ReactFlow>

      {pending && (
        <ConnectionModal
          onClose={() => setPending(null)}
          onSubmit={(type: ConnectionType, label) => {
            addConnection(pending.source, pending.target, type, label)
            setPending(null)
          }}
        />
      )}
    </div>
  )
}
