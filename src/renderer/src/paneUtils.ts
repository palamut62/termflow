import type { PaneNode, LeafPane, SplitPane } from '../../shared/types'

/** Collect all leaf terminalIds from a pane tree. */
export function getLeafTerminalIds(pane: PaneNode): string[] {
  if (pane.type === 'leaf') return [pane.terminalId]
  return [...getLeafTerminalIds(pane.a), ...getLeafTerminalIds(pane.b)]
}

/** Get the active terminalId from a node, accounting for pane tree. */
export function getActiveTerminalId(
  activePaneId: string | undefined,
  panes: PaneNode | undefined,
  terminalId: string | undefined
): string | undefined {
  if (activePaneId) return activePaneId
  if (panes) {
    const leaves = getLeafTerminalIds(panes)
    return leaves[0]
  }
  return terminalId
}

/** Count total leaf terminals in a pane tree. */
export function countLeaves(pane: PaneNode): number {
  if (pane.type === 'leaf') return 1
  return countLeaves(pane.a) + countLeaves(pane.b)
}

/** Find a leaf by terminalId in a pane tree. Returns path array or null. */
export function findLeafPath(pane: PaneNode, terminalId: string): number[] | null {
  if (pane.type === 'leaf') {
    return pane.terminalId === terminalId ? [] : null
  }
  const pathA = findLeafPath(pane.a, terminalId)
  if (pathA) return [0, ...pathA]
  const pathB = findLeafPath(pane.b, terminalId)
  if (pathB) return [1, ...pathB]
  return null
}

/** Split a leaf pane into a split with two leaves. */
export function splitPane(
  pane: PaneNode,
  terminalIdToSplit: string,
  dir: 'horizontal' | 'vertical',
  existingTitle: string,
  newTermId: string,
  newTitle: string
): PaneNode {
  if (pane.type === 'leaf') {
    if (pane.terminalId !== terminalIdToSplit) return pane
    return {
      type: 'split',
      dir,
      ratio: 0.5,
      a: { type: 'leaf', terminalId: pane.terminalId, title: existingTitle },
      b: { type: 'leaf', terminalId: newTermId, title: newTitle }
    }
  }
  return {
    ...pane,
    a: splitPane(pane.a, terminalIdToSplit, dir, existingTitle, newTermId, newTitle),
    b: splitPane(pane.b, terminalIdToSplit, dir, existingTitle, newTermId, newTitle)
  }
}

/** Close a leaf pane; collapses splits that would have only one child. */
export function closePane(pane: PaneNode, terminalIdToClose: string): PaneNode | null {
  if (pane.type === 'leaf') {
    return pane.terminalId === terminalIdToClose ? null : pane
  }
  const newA = closePane(pane.a, terminalIdToClose)
  const newB = closePane(pane.b, terminalIdToClose)
  if (!newA && !newB) return null
  if (!newA) return newB!
  if (!newB) return newA!
  return { ...pane, a: newA, b: newB }
}

/** Update ratio of a split pane at the given path. */
export function setPaneRatio(pane: PaneNode, path: number[], ratio: number): PaneNode {
  if (path.length === 0) {
    if (pane.type === 'split') return { ...pane, ratio: Math.max(0.15, Math.min(0.85, ratio)) }
    return pane
  }
  if (pane.type === 'leaf') return pane
  const [head, ...tail] = path
  if (head === 0) return { ...pane, a: setPaneRatio(pane.a, tail, ratio) }
  return { ...pane, b: setPaneRatio(pane.b, tail, ratio) }
}

/** Replace a leaf at the given path (for tab switching). */
export function getLeafAtPath(pane: PaneNode, path: number[]): LeafPane | null {
  if (path.length === 0) return pane.type === 'leaf' ? pane : null
  if (pane.type === 'leaf') return null
  const [head, ...tail] = path
  return head === 0 ? getLeafAtPath(pane.a, tail) : getLeafAtPath(pane.b, tail)
}
