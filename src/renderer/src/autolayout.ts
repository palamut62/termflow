import type { CanvasNode, LayoutMode, AgentConnection } from '../../shared/types'

interface Viewport {
  width: number
  height: number
}

// Tiled terminal layouts use the whole canvas. The one-pixel overlap keeps
// adjacent borders from becoming a visually heavy double line.
const GAP = -1
const PAD = 0

/**
 * Compute node positions/sizes for the automatic layout modes (PRD §10.4).
 * Returns a map of nodeId -> {position,size}. Minimized nodes keep their size
 * small and flow in a compact strip.
 */
export function computeLayout(
  mode: LayoutMode,
  nodes: CanvasNode[],
  vp: Viewport,
  connections: AgentConnection[] = []
): Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }> {
  const result: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }> = {}
  const visible = nodes.filter((n) => !n.isMinimized)
  const n = visible.length
  if (n === 0) return result

  if (mode === 'agent_graph') return agentGraphLayout(visible, connections)

  const areaW = Math.max(vp.width - PAD * 2, 1)
  const areaH = Math.max(vp.height - PAD * 2, 1)

  let cols = 1
  let rows = 1

  switch (mode) {
    case 'columns':
      cols = n
      rows = 1
      break
    case 'rows':
      cols = 1
      rows = n
      break
    case 'grid':
    case 'auto_fit': {
      cols = Math.ceil(Math.sqrt((n * areaW) / areaH))
      cols = Math.max(1, Math.min(cols, n))
      rows = Math.ceil(n / cols)
      break
    }
    case 'focus': {
      return focusLayout(visible, areaW, areaH)
    }
    default: {
      // fallback grid
      cols = Math.ceil(Math.sqrt(n))
      rows = Math.ceil(n / cols)
    }
  }

  const cellW = (areaW - GAP * (cols - 1)) / cols
  const cellH = (areaH - GAP * (rows - 1)) / rows

  visible.forEach((node, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    result[node.id] = {
      position: { x: PAD + c * (cellW + GAP), y: PAD + r * (cellH + GAP) },
      size: { width: Math.round(cellW), height: Math.round(cellH) }
    }
  })
  return result
}

/**
 * Layered left-to-right layout driven by connections (PRD §10.4.8). Each node's
 * column = longest path from a root; nodes with no inputs are roots (column 0).
 */
function agentGraphLayout(
  nodes: CanvasNode[],
  connections: AgentConnection[]
): Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }> {
  const result: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }> = {}
  const ids = new Set(nodes.map((n) => n.id))
  const edges = connections.filter((c) => ids.has(c.sourceNodeId) && ids.has(c.targetNodeId))
  const depth = new Map<string, number>()
  nodes.forEach((n) => depth.set(n.id, 0))

  // Relax depths (works for DAGs; cycles converge after |nodes| passes).
  for (let i = 0; i < nodes.length; i++) {
    let changed = false
    for (const e of edges) {
      const d = (depth.get(e.sourceNodeId) ?? 0) + 1
      if (d > (depth.get(e.targetNodeId) ?? 0)) {
        depth.set(e.targetNodeId, d)
        changed = true
      }
    }
    if (!changed) break
  }

  const cols = new Map<number, CanvasNode[]>()
  for (const node of nodes) {
    const d = depth.get(node.id) ?? 0
    if (!cols.has(d)) cols.set(d, [])
    cols.get(d)!.push(node)
  }

  const colW = 520
  const rowH = 400
  for (const [d, colNodes] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    colNodes.forEach((node, r) => {
      result[node.id] = {
        position: { x: PAD + d * colW, y: PAD + r * rowH },
        size: { width: 460, height: 320 }
      }
    })
  }
  return result
}

function focusLayout(
  nodes: CanvasNode[],
  areaW: number,
  areaH: number
): Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }> {
  const result: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }> = {}
  if (nodes.length === 1) {
    result[nodes[0].id] = { position: { x: 0, y: 0 }, size: { width: areaW, height: areaH } }
    return result
  }

  const mainW = Math.round(areaW * 0.68)
  const stripW = areaW - mainW - GAP
  const active = nodes[0]
  result[active.id] = { position: { x: 0, y: 0 }, size: { width: mainW, height: areaH } }
  const rest = nodes.slice(1)
  const miniH = rest.length ? (areaH - GAP * (rest.length - 1)) / rest.length : areaH
  rest.forEach((node, i) => {
    result[node.id] = {
      position: { x: mainW + GAP, y: i * (miniH + GAP) },
      size: { width: stripW, height: Math.round(miniH) }
    }
  })
  return result
}
