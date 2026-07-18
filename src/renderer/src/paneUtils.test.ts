import { describe, expect, it } from 'vitest'
import type { PaneNode } from '../../shared/types'
import { closePane, countLeaves, findLeafPath, getLeafTerminalIds, setPaneRatio, splitPane } from './paneUtils'

const root: PaneNode = { type: 'leaf', terminalId: 'a', title: 'A' }

describe('pane tree operations', () => {
  it('splits, locates and collapses panes without losing the survivor', () => {
    const split = splitPane(root, 'a', 'horizontal', 'A', 'b', 'B')
    expect(getLeafTerminalIds(split)).toEqual(['a', 'b'])
    expect(countLeaves(split)).toBe(2)
    expect(findLeafPath(split, 'b')).toEqual([1])
    expect(closePane(split, 'a')).toEqual({ type: 'leaf', terminalId: 'b', title: 'B' })
  })

  it('clamps pane ratios to usable bounds', () => {
    const split = splitPane(root, 'a', 'vertical', 'A', 'b', 'B')
    expect(setPaneRatio(split, [], 0.01)).toMatchObject({ ratio: 0.15 })
    expect(setPaneRatio(split, [], 0.99)).toMatchObject({ ratio: 0.85 })
  })
})
