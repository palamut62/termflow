import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './appStore'

// These tests exercise pure, window-free state transitions across the split
// slices. Actions that call persist() are safe here because persist() short-
// circuits when there is no active workspace.
const reset = (): void =>
  useAppStore.setState({
    activeWorkspaceId: null,
    nodes: [],
    layoutMode: 'manual',
    viewport: { zoom: 1, x: 0, y: 0 },
    broadcastEnabled: false,
    broadcastGroup: [],
    recordingLimitWarning: null
  })

beforeEach(reset)

describe('layout slice', () => {
  it('switches layout mode', () => {
    useAppStore.getState().setLayoutMode('grid')
    expect(useAppStore.getState().layoutMode).toBe('grid')
  })

  it('updates the viewport', () => {
    useAppStore.getState().setViewport({ zoom: 2, x: 10, y: 20 })
    expect(useAppStore.getState().viewport).toEqual({ zoom: 2, x: 10, y: 20 })
  })

  it('toggles a node minimize flag and renames it', () => {
    useAppStore.setState({ nodes: [{ id: 'n1', title: 'One', isMinimized: false } as never] })
    useAppStore.getState().toggleMinimize('n1')
    expect(useAppStore.getState().nodes[0].isMinimized).toBe(true)
    useAppStore.getState().renameNode('n1', 'Renamed')
    expect(useAppStore.getState().nodes[0].title).toBe('Renamed')
  })

  it('selects and clears the active node', () => {
    useAppStore.setState({ nodes: [{ id: 'n1', zIndex: 1, isMinimized: false } as never] })
    useAppStore.getState().setActiveNode('n1')
    expect(useAppStore.getState().activeNodeId).toBe('n1')
    useAppStore.getState().setActiveNode(null)
    expect(useAppStore.getState().activeNodeId).toBeNull()
  })

  it('keeps grid geometry when a terminal is selected', () => {
    useAppStore.setState({
      layoutMode: 'grid',
      canvasSize: { width: 1200, height: 800 },
      nodes: [
        { id: 'n1', position: { x: 0, y: 0 }, size: { width: 600, height: 400 }, isMinimized: false } as never,
        { id: 'n2', position: { x: 599, y: 0 }, size: { width: 600, height: 400 }, isMinimized: false } as never
      ]
    })

    useAppStore.getState().setActiveNode('n2')

    expect(useAppStore.getState().layoutMode).toBe('grid')
    expect(useAppStore.getState().nodes.map((node) => node.size.width)).toEqual([600, 600])
  })
})

describe('terminal slice', () => {
  it('toggles broadcast and manages the broadcast group', () => {
    const s = useAppStore.getState()
    s.toggleBroadcast()
    expect(useAppStore.getState().broadcastEnabled).toBe(true)

    s.addToBroadcastGroup('t1')
    s.addToBroadcastGroup('t1') // idempotent
    expect(useAppStore.getState().broadcastGroup).toEqual(['t1'])

    s.removeFromBroadcastGroup('t1')
    expect(useAppStore.getState().broadcastGroup).toEqual([])
  })

  it('dismisses recording warnings', () => {
    useAppStore.setState({
      recordingLimitWarning: { terminalId: 't', reason: 'size' }
    })
    useAppStore.getState().dismissRecordingLimitWarning()
    expect(useAppStore.getState().recordingLimitWarning).toBeNull()
  })
})
