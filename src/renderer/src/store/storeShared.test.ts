import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentConnection, CanvasNode } from '../../../shared/types'

// syncAgentRouting is the sole consumer of AgentConnection.routeDirection: it
// resolves 'bidirectional' by adding a routing rule in both directions before
// ever building the per-terminal RoutingRule[] sent to the main process.
// RoutingRule itself has no routeDirection field on purpose — each resolved
// rule is already inherently one-directional (source terminal -> targets), so
// storing direction there again would be redundant. This test locks that
// behavior in so it can't silently regress. (item: routeDirection tip tutarlılığı)
import { syncAgentRouting } from './storeShared'

function node(id: string, terminalId: string): CanvasNode {
  return {
    id,
    workspaceId: 'ws',
    terminalId,
    title: id,
    nodeType: 'agent',
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    zIndex: 1,
    isMinimized: false,
    isMaximized: false,
    status: 'running',
    showInfo: false
  }
}

function connection(overrides: Partial<AgentConnection>): AgentConnection {
  return {
    id: 'c1',
    workspaceId: 'ws',
    sourceNodeId: 'a',
    targetNodeId: 'b',
    connectionType: 'trigger',
    isActive: true,
    status: 'idle',
    routeBehavior: 'marker',
    ...overrides
  }
}

describe('syncAgentRouting / routeDirection', () => {
  let setRouting: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setRouting = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = {
      termflow: { agent: { setRouting } }
    }
  })

  it('routes source -> target only when unidirectional', () => {
    const nodes = [node('a', 'termA'), node('b', 'termB')]
    const conn = connection({ routeDirection: 'source_to_target' })
    syncAgentRouting(nodes, [conn])

    const calls = new Map(setRouting.mock.calls.map(([id, rules]) => [id, rules]))
    expect(calls.get('termA')).toHaveLength(1)
    expect(calls.get('termB')).toHaveLength(0)
  })

  it('routes both ways when bidirectional', () => {
    const nodes = [node('a', 'termA'), node('b', 'termB')]
    const conn = connection({ routeDirection: 'bidirectional' })
    syncAgentRouting(nodes, [conn])

    const calls = new Map(setRouting.mock.calls.map(([id, rules]) => [id, rules]))
    expect(calls.get('termA')).toHaveLength(1)
    expect((calls.get('termA') as { targetTerminalIds: string[] }[])[0].targetTerminalIds).toEqual(['termB'])
    expect(calls.get('termB')).toHaveLength(1)
    expect((calls.get('termB') as { targetTerminalIds: string[] }[])[0].targetTerminalIds).toEqual(['termA'])
  })

  it('skips disabled/inactive connections entirely', () => {
    const nodes = [node('a', 'termA'), node('b', 'termB')]
    syncAgentRouting(nodes, [connection({ routeBehavior: 'disabled' })])
    const calls = new Map(setRouting.mock.calls.map(([id, rules]) => [id, rules]))
    expect(calls.get('termA')).toHaveLength(0)
  })
})
