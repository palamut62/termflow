import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type NodeProps,
  useReactFlow
} from '@xyflow/react'
import TerminalNode from './TerminalNode'
import ConnectionModal, { type ConnectionFormResult } from '../components/ConnectionModal'
import ConfirmModal from '../components/ConfirmModal'
import { useAppStore } from '../store/appStore'
import { Bot, FolderOpen, Settings } from 'lucide-react'

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
  const setStoredViewport = useAppStore((s) => s.setViewport)
  const { setViewport: setFlowViewport } = useReactFlow()
  const wrapRef = useRef<HTMLDivElement>(null)
  const activeNodeId = useAppStore((s) => s.activeNodeId)
  const tiled = useAppStore((s) => s.layoutMode !== 'manual' && s.layoutMode !== 'agent_graph')
  const [pending, setPending] = useState<{ source: string; target: string } | null>(null)
  const [deleteEdgeId, setDeleteEdgeId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const addTerminal = useAppStore((s) => s.addTerminal)
  const providerProfiles = useAppStore((s) => s.settings.providerProfiles)

  useEffect(() => {
    if (!tiled) return
    void setFlowViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 })
    setStoredViewport({ x: 0, y: 0, zoom: 1 })
  }, [setFlowViewport, setStoredViewport, tiled])

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
          setDeleteEdgeId(edge.id)
        }}
        onPaneClick={() => {
          setContextMenu(null)
          setActiveNode(null)
          selectConnection(null)
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault()
          const bounds = wrapRef.current?.getBoundingClientRect()
          setContextMenu({ x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) })
        }}
        onMoveEnd={(_e, vp) => setStoredViewport({ zoom: vp.zoom, x: vp.x, y: vp.y })}
        minZoom={tiled ? 1 : 0.2}
        maxZoom={tiled ? 1 : 2}
        zoomOnScroll={!tiled}
        zoomOnPinch={!tiled}
        zoomOnDoubleClick={!tiled}
        panOnDrag={!tiled}
        snapToGrid={snapToGrid}
        snapGrid={[22, 22]}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        defaultViewport={{ x: 0, y: 0, zoom: tiled ? 1 : 0.85 }}
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

      {contextMenu && (
        <div className="menu canvas-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <div className="menu-label">Open AI provider</div>
          {providerProfiles.map((provider) => (
            <div className="menu-item" key={provider.id} onClick={() => {
              const env: Record<string, string> = {}
              if (provider.baseUrlEnv && provider.baseUrl) env[provider.baseUrlEnv] = provider.baseUrl
              if (provider.modelEnv && provider.model) env[provider.modelEnv] = provider.model
              const command = provider.fullPermissionArgs ? `${provider.command} ${provider.fullPermissionArgs}` : provider.command
              addTerminal('custom', { name: provider.name, startupCommand: command, env })
              setContextMenu(null)
            }}><Bot size={14} color={provider.color} />{provider.name}</div>
          ))}
          <div className="menu-sep" />
          <div className="menu-item" onClick={() => { setContextMenu(null); window.dispatchEvent(new CustomEvent('termflow:open-terminal-launcher')) }}><FolderOpen size={14} />Open terminal at folder...</div>
          <div className="menu-item" onClick={() => { setContextMenu(null); window.dispatchEvent(new CustomEvent('termflow:open-provider-manager')) }}><Settings size={14} />Configure providers...</div>
        </div>
      )}

      {pending && (
        <ConnectionModal
          onClose={() => setPending(null)}
          onSubmit={(result: ConnectionFormResult) => {
            addConnection(pending.source, pending.target, result.type, result.label, {
              triggerPattern: result.triggerPattern,
              transform: result.transform,
              routeBehavior: result.routeBehavior,
              routeDirection: result.routeDirection
            })
            setPending(null)
          }}
        />
      )}
      {deleteEdgeId && (
        <ConfirmModal
          title="Delete connection"
          message="This removes the visual connection and any routing attached to it."
          confirmLabel="Delete"
          tone="danger"
          onConfirm={() => removeConnection(deleteEdgeId)}
          onClose={() => setDeleteEdgeId(null)}
        />
      )}
    </div>
  )
}
