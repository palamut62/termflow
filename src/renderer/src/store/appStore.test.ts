import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './appStore'

// These tests exercise pure, window-free state transitions across the split
// slices. Actions that call persist() are safe here because persist() short-
// circuits when there is no active workspace.
const reset = (): void =>
  useAppStore.setState({
    activeWorkspaceId: null,
    nodes: [],
    connections: [],
    layoutMode: 'manual',
    viewport: { zoom: 1, x: 0, y: 0 },
    selectedConnectionId: null,
    broadcastEnabled: false,
    broadcastGroup: [],
    agentActivities: [],
    detectedAgents: {},
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

  it('selects and clears a connection', () => {
    useAppStore.getState().selectConnection('c1')
    expect(useAppStore.getState().selectedConnectionId).toBe('c1')
    useAppStore.getState().selectConnection(null)
    expect(useAppStore.getState().selectedConnectionId).toBeNull()
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

  it('clears agent activities and dismisses recording warnings', () => {
    useAppStore.setState({
      agentActivities: [{ id: 'a', terminalId: 't', agentName: 'X', kind: 'status', message: 'm', createdAt: '' }],
      recordingLimitWarning: { terminalId: 't', reason: 'size' }
    })
    useAppStore.getState().clearAgentActivities()
    expect(useAppStore.getState().agentActivities).toEqual([])
    useAppStore.getState().dismissRecordingLimitWarning()
    expect(useAppStore.getState().recordingLimitWarning).toBeNull()
  })
})
