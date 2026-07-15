import type { StateCreator } from 'zustand'
import { nanoid } from 'nanoid'
import type {
  CanvasNode,
  AgentConnection,
  LayoutMode,
  ConnectionType,
  CanvasViewport
} from '../../../../shared/types'
import { computeLayout } from '../../autolayout'
import { syncAgentRouting } from '../storeShared'
import type { AppState } from '../appStore'

export interface LayoutSlice {
  nodes: CanvasNode[]
  connections: AgentConnection[]
  activeNodeId: string | null
  selectedConnectionId: string | null
  developerCenterOpen: boolean
  layoutMode: LayoutMode
  viewport: CanvasViewport
  zCounter: number
  canvasSize: { width: number; height: number }

  setCanvasSize: (size: { width: number; height: number }) => void
  setActiveNode: (nodeId: string | null) => void
  selectConnection: (id: string | null) => void
  setDeveloperCenterOpen: (open: boolean) => void
  updateNode: (nodeId: string, patch: Partial<CanvasNode>) => void
  toggleMinimize: (nodeId: string) => void
  toggleMaximize: (nodeId: string) => void
  toggleInfo: (nodeId: string) => void
  renameNode: (nodeId: string, title: string) => void
  togglePin: (nodeId: string) => void

  addConnection: (source: string, target: string, type: ConnectionType, label?: string, routeOpts?: { triggerPattern?: string; transform?: string; routeBehavior?: 'marker' | 'continuous' | 'disabled'; routeDirection?: 'source_to_target' | 'bidirectional' }) => void
  removeConnection: (id: string) => void

  setLayoutMode: (mode: LayoutMode, vp?: { width: number; height: number }) => void
  applyAutoLayout: (vp: { width: number; height: number }) => void
  resizeFocusedNode: (nodeId: string, width: number) => void
  resolveCollisions: (anchorId: string) => void
  reorderNode: (nodeId: string, dropCenter: { x: number; y: number }) => void
  setViewport: (vp: CanvasViewport) => void

  persist: () => void
  flushPersist: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const createLayoutSlice: StateCreator<AppState, [], [], LayoutSlice> = (set, get) => ({
  nodes: [],
  connections: [],
  activeNodeId: null,
  selectedConnectionId: null,
  developerCenterOpen: false,
  layoutMode: 'manual',
  viewport: { zoom: 1, x: 0, y: 0 },
  zCounter: 1,
  canvasSize: { width: 1200, height: 800 },

  setCanvasSize: (size) => {
    const st = get()
    if (st.layoutMode === 'manual' || st.layoutMode === 'agent_graph') {
      set({ canvasSize: size })
      return
    }
    const ordered = st.activeNodeId
      ? [...st.nodes.filter((n) => n.id === st.activeNodeId), ...st.nodes.filter((n) => n.id !== st.activeNodeId)]
      : st.nodes
    const computed = computeLayout(st.layoutMode, ordered, size, st.connections)
    set({
      canvasSize: size,
      nodes: st.nodes.map((n) => (computed[n.id] ? { ...n, ...computed[n.id] } : n))
    })
  },

  setActiveNode: (nodeId) => {
    const current = get()
    const shouldRelayoutFocus = current.layoutMode === 'focus'
    if (!shouldRelayoutFocus) {
      const z = current.zCounter + 1
      set((s) => ({
        activeNodeId: nodeId,
        selectedConnectionId: null,
        zCounter: nodeId ? z : s.zCounter,
        nodes: nodeId
          ? s.nodes.map((n) => n.id === nodeId ? { ...n, zIndex: z } : n)
          : s.nodes
      }))
      return
    }
    if (nodeId && nodeId === current.activeNodeId) {
      set({ selectedConnectionId: null })
      return
    }
    if (!nodeId) {
      set({ activeNodeId: null, selectedConnectionId: null })
      return
    }
    const st = get()
    const z = st.zCounter + 1
    const ordered = [
      ...st.nodes.filter((n) => n.id === nodeId),
      ...st.nodes.filter((n) => n.id !== nodeId && !n.isMinimized)
    ]
    const computed = computeLayout('focus', ordered, st.canvasSize, st.connections)
    set((s) => ({
      activeNodeId: nodeId,
      selectedConnectionId: null,
      zCounter: z,
      nodes: s.nodes.map((n) => ({
        ...n,
        isMaximized: false,
        ...(computed[n.id] || {}),
        ...(n.id === nodeId ? { zIndex: z, status: n.status === 'error' ? 'idle' as const : n.status } : {})
      }))
    }))
    get().persist()
  },

  selectConnection: (id) => set({ selectedConnectionId: id, activeNodeId: id ? null : get().activeNodeId }),
  setDeveloperCenterOpen: (open) => set({ developerCenterOpen: open }),

  updateNode: (nodeId, patch) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }))
    get().persist()
  },

  toggleMinimize: (nodeId) => {
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, isMinimized: !n.isMinimized, isMaximized: false } : n))
    }))
    get().persist()
  },

  toggleMaximize: (nodeId) => {
    const st = get()
    const node = st.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const z = st.zCounter + 1
    if (!node.isMaximized) {
      // "Maximize" = focus layout centered on this node: it becomes large while
      // the others scale down into a mini-panel strip. (user request #5)
      const ordered = [node, ...st.nodes.filter((n) => n.id !== nodeId && !n.isMinimized)]
      const computed = computeLayout('focus', ordered, st.canvasSize, st.connections)
      set((s) => ({
        zCounter: z,
        activeNodeId: nodeId,
        layoutMode: 'focus',
        nodes: s.nodes.map((n) => ({
          ...n,
          isMaximized: n.id === nodeId,
          isMinimized: n.id === nodeId ? false : n.isMinimized,
          zIndex: n.id === nodeId ? z : n.zIndex,
          ...(computed[n.id] || {})
        }))
      }))
    } else {
      // Restore: re-tile everything as a proportional grid.
      const computed = computeLayout('grid', st.nodes, st.canvasSize, st.connections)
      set((s) => ({
        layoutMode: 'grid',
        nodes: s.nodes.map((n) => ({ ...n, isMaximized: false, ...(computed[n.id] || {}) }))
      }))
    }
    get().persist()
  },

  toggleInfo: (nodeId) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, showInfo: !n.showInfo } : n)) }))
    get().persist()
  },

  renameNode: (nodeId, title) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, title } : n)) }))
    get().persist()
  },

  togglePin: (nodeId) => {
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, isPinned: !n.isPinned } : n)) }))
    get().persist()
  },

  addConnection: (source, target, type, label, routeOpts) => {
    if (source === target) return
    const st = get()
    if (!st.activeWorkspaceId) return
    // avoid duplicate identical edges
    if (st.connections.some((c) => c.sourceNodeId === source && c.targetNodeId === target && c.connectionType === type))
      return
    const conn: AgentConnection = {
      id: nanoid(),
      workspaceId: st.activeWorkspaceId,
      sourceNodeId: source,
      targetNodeId: target,
      connectionType: type,
      label,
      isActive: true,
      status: 'idle',
      triggerPattern: routeOpts?.triggerPattern,
      transform: routeOpts?.transform,
      routeBehavior: routeOpts?.routeBehavior || 'disabled',
      routeDirection: routeOpts?.routeDirection || 'source_to_target'
    }

    const nextConnections = [...st.connections, conn]
    syncAgentRouting(st.nodes, nextConnections)
    set({ connections: nextConnections, selectedConnectionId: conn.id })
    get().persist()
  },

  removeConnection: (id) => {
    const st = get()
    const connections = st.connections.filter((c) => c.id !== id)
    syncAgentRouting(st.nodes, connections)
    set({
      connections,
      selectedConnectionId: st.selectedConnectionId === id ? null : st.selectedConnectionId
    })
    get().persist()
  },

  setLayoutMode: (mode, vp) => {
    set({ layoutMode: mode })
    if (mode !== 'manual' && vp) get().applyAutoLayout(vp)
    else get().persist()
  },

  applyAutoLayout: (vp) => {
    const st = get()
    if (st.layoutMode === 'manual') return
    const computed = computeLayout(st.layoutMode, st.nodes, vp, st.connections)
    set((s) => ({
      nodes: s.nodes.map((n) => (computed[n.id] ? { ...n, ...computed[n.id], isMaximized: false } : n))
    }))
    get().persist()
  },

  resizeFocusedNode: (nodeId, requestedWidth) => {
    const st = get()
    const active = st.nodes.find((n) => n.id === nodeId)
    const rest = st.nodes.filter((n) => n.id !== nodeId && !n.isMinimized)
    if (!active || !rest.length) return

    const minActiveWidth = Math.min(280, Math.round(st.canvasSize.width * 0.35))
    const minRestWidth = Math.min(240, Math.round(st.canvasSize.width * 0.3))
    const width = Math.round(Math.max(minActiveWidth, Math.min(requestedWidth, st.canvasSize.width - minRestWidth)))
    const restWidth = st.canvasSize.width - width + 1
    const restHeight = (st.canvasSize.height + rest.length - 1) / rest.length

    set((s) => ({
      nodes: s.nodes.map((n) => {
        if (n.id === nodeId) return { ...n, position: { x: 0, y: 0 }, size: { width, height: st.canvasSize.height } }
        const index = rest.findIndex((item) => item.id === n.id)
        if (index === -1) return n
        return {
          ...n,
          position: { x: width - 1, y: Math.round(index * (restHeight - 1)) },
          size: { width: restWidth, height: Math.round(restHeight) }
        }
      })
    }))
  },

  // Push neighbours out of the way so a resized/dragged node never overlaps
  // another; the anchor stays put and everything else slides to fit. (user)
  resolveCollisions: (anchorId) => {
    const GAP = 16
    const nodes = get().nodes.map((n) => ({
      ...n,
      position: { ...n.position },
      size: { ...n.size }
    }))
    const anchor = nodes.find((n) => n.id === anchorId)
    if (!anchor) return
    const overlaps = (a: CanvasNode, b: CanvasNode): boolean =>
      a.position.x < b.position.x + b.size.width + GAP &&
      a.position.x + a.size.width + GAP > b.position.x &&
      a.position.y < b.position.y + b.size.height + GAP &&
      a.position.y + a.size.height + GAP > b.position.y

    // Only push nodes that overlap the anchor, away from the anchor, once.
    // Direction follows each node's current side (by centre) so nothing jumps
    // across the anchor; clamp to >= 0 so panels never fly off-canvas.
    const acx = anchor.position.x + anchor.size.width / 2
    const acy = anchor.position.y + anchor.size.height / 2
    let changed = false
    for (const other of nodes) {
      if (other.id === anchorId || other.isMinimized || other.isMaximized) continue
      if (!overlaps(anchor, other)) continue
      const dx = other.position.x + other.size.width / 2 - acx
      const dy = other.position.y + other.size.height / 2 - acy
      if (Math.abs(dx) >= Math.abs(dy)) {
        other.position.x =
          dx >= 0 ? anchor.position.x + anchor.size.width + GAP : anchor.position.x - other.size.width - GAP
      } else {
        other.position.y =
          dy >= 0 ? anchor.position.y + anchor.size.height + GAP : anchor.position.y - other.size.height - GAP
      }
      other.position.x = Math.max(0, other.position.x)
      other.position.y = Math.max(0, other.position.y)
      changed = true
    }
    if (changed) {
      set({ nodes })
      get().persist()
    }
  },

  // Tiled-mode reorder: dropping a node onto/near another slot re-sequences the
  // nodes array (slot order = array order) and re-applies the layout so panels
  // stay perfectly tiled instead of overlapping. (feature: drag-to-reorder)
  reorderNode: (nodeId, dropCenter) => {
    const st = get()
    const node = st.nodes.find((n) => n.id === nodeId)
    if (!node) return
    // Pinned/minimized nodes are outside the tiling pass — keep the free-drag
    // behaviour (slide neighbours out of the way) for them.
    if (node.isPinned || node.isMinimized) {
      st.resolveCollisions(nodeId)
      return
    }
    const isTiled = (n: CanvasNode): boolean => !n.isMinimized && !n.isPinned
    const visibleIds = st.nodes.filter(isTiled).map((n) => n.id)
    if (visibleIds.length < 2) {
      st.resolveCollisions(nodeId)
      return
    }
    // Slot centres come from the current layout (dragged node's old slot
    // included) so the drop point can snap to any existing slot.
    const computed = computeLayout(st.layoutMode, st.nodes, st.canvasSize, st.connections)
    let targetIndex = 0
    let best = Infinity
    visibleIds.forEach((id, i) => {
      const slot = computed[id]
      if (!slot) return
      const cx = slot.position.x + slot.size.width / 2
      const cy = slot.position.y + slot.size.height / 2
      const dist = (cx - dropCenter.x) ** 2 + (cy - dropCenter.y) ** 2
      if (dist < best) {
        best = dist
        targetIndex = i
      }
    })

    const currentIndex = visibleIds.indexOf(nodeId)
    if (currentIndex === targetIndex) {
      // No reorder — just re-tile so the dragged node snaps back to its slot.
      const restore = computeLayout(st.layoutMode, st.nodes, st.canvasSize, st.connections)
      set((s) => ({ nodes: s.nodes.map((n) => (restore[n.id] ? { ...n, ...restore[n.id] } : n)) }))
      get().persist()
      return
    }

    const nextOrder = visibleIds.filter((id) => id !== nodeId)
    nextOrder.splice(targetIndex, 0, nodeId)
    const byId = new Map(st.nodes.map((n) => [n.id, n]))
    // Rebuild the nodes array: visible slots take the new order, other nodes
    // (pinned/minimized) keep their array positions untouched.
    let vi = 0
    const reordered = st.nodes.map((n) => (isTiled(n) ? byId.get(nextOrder[vi++])! : n))
    const computedNext = computeLayout(st.layoutMode, reordered, st.canvasSize, st.connections)
    set({ nodes: reordered.map((n) => (computedNext[n.id] ? { ...n, ...computedNext[n.id] } : n)) })
    get().persist()
  },

  setViewport: (vp) => set({ viewport: vp }),

  persist: () => {
    const st = get()
    if (!st.activeWorkspaceId) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => get().flushPersist(), 400)
  },

  flushPersist: () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const s = get()
    if (!s.activeWorkspaceId) return
    window.termflow.layout.save({
      workspaceId: s.activeWorkspaceId,
      nodes: s.nodes,
      connections: s.connections,
      layoutMode: s.layoutMode,
      viewport: s.viewport,
      activeNodeId: s.activeNodeId || undefined
    })
  }
})
