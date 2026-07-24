import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './appStore'

// These tests exercise pure, window-free state transitions across the split
// slices. Actions that call persist() are safe here because persist() short-
// circuits when there is no active workspace.
const reset = (): void =>
  useAppStore.setState({
    activeWorkspaceId: null,
    nodes: [],
    activeNodeId: null,
    broadcastEnabled: false,
    broadcastGroup: [],
    recordingLimitWarning: null
  })

beforeEach(reset)

describe('window slice', () => {
  it('renames a window', () => {
    useAppStore.setState({ nodes: [{ id: 'n1', title: 'One' } as never] })
    useAppStore.getState().renameNode('n1', 'Renamed')
    expect(useAppStore.getState().nodes[0].title).toBe('Renamed')
  })

  it('selects and clears the active window, clearing its error marker', () => {
    useAppStore.setState({ nodes: [{ id: 'n1', status: 'error' } as never] })
    useAppStore.getState().setActiveNode('n1')
    expect(useAppStore.getState().activeNodeId).toBe('n1')
    expect(useAppStore.getState().nodes[0].status).toBe('idle')
    useAppStore.getState().setActiveNode(null)
    expect(useAppStore.getState().activeNodeId).toBeNull()
  })

  it('reorders windows in the tab strip', () => {
    useAppStore.setState({
      nodes: [{ id: 'a' } as never, { id: 'b' } as never, { id: 'c' } as never]
    })
    useAppStore.getState().moveNode('c', 0)
    expect(useAppStore.getState().nodes.map((n) => n.id)).toEqual(['c', 'a', 'b'])
    useAppStore.getState().moveNode('c', 99) // clamped to the last slot
    expect(useAppStore.getState().nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('patches a window without touching the others', () => {
    useAppStore.setState({ nodes: [{ id: 'n1', title: 'One' } as never, { id: 'n2', title: 'Two' } as never] })
    useAppStore.getState().updateNode('n2', { status: 'stopped' })
    expect(useAppStore.getState().nodes[1].status).toBe('stopped')
    expect(useAppStore.getState().nodes[0].status).toBeUndefined()
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
