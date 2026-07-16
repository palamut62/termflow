import { describe, it, expect, beforeAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import type { PaneNode } from '../../shared/types'

const tmp = mkdtempSync(join(tmpdir(), 'tf-db-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'home' ? tmp : tmp)
  }
}))

// Imported after the mock is registered (vi.mock is hoisted).
import {
  remapPaneIds,
  initDatabase,
  listWorkspaces,
  upsertTerminal,
  listTerminals,
  deleteTerminal
} from './database'
import type { TerminalSession } from '../../shared/types'

describe('remapPaneIds', () => {
  it('remaps a leaf pane terminalId', () => {
    const leaf: PaneNode = { type: 'leaf', terminalId: 'old', title: 'T' }
    const out = remapPaneIds(leaf, (id) => id + '-new')
    expect(out).toEqual({ type: 'leaf', terminalId: 'old-new', title: 'T' })
  })

  it('remaps nested split panes recursively', () => {
    const tree: PaneNode = {
      type: 'split',
      dir: 'horizontal',
      ratio: 0.5,
      a: { type: 'leaf', terminalId: 'a', title: 'A' },
      b: {
        type: 'split',
        dir: 'vertical',
        ratio: 0.5,
        a: { type: 'leaf', terminalId: 'b', title: 'B' },
        b: { type: 'leaf', terminalId: 'c', title: 'C' }
      }
    }
    const out = remapPaneIds(tree, (id) => id.toUpperCase()) as any
    expect(out.a.terminalId).toBe('A')
    expect(out.b.a.terminalId).toBe('B')
    expect(out.b.b.terminalId).toBe('C')
  })

  it('returns undefined for undefined pane', () => {
    expect(remapPaneIds(undefined, (id) => id)).toBeUndefined()
  })
})

describe('database round-trip', () => {
  let wsId: string

  beforeAll(() => {
    initDatabase()
    wsId = listWorkspaces()[0].id
  })

  it('seeds a default workspace', () => {
    expect(listWorkspaces().length).toBeGreaterThanOrEqual(1)
  })

  it('upserts, lists and deletes a terminal', () => {
    const term: TerminalSession = {
      id: 'term-1',
      workspaceId: wsId,
      name: 'T1',
      kind: 'cmd',
      shell: 'cmd.exe',
      args: [],
      cwd: 'C:\\',
      status: 'stopped',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    upsertTerminal(term)
    expect(listTerminals(wsId).map((t) => t.id)).toContain('term-1')

    deleteTerminal('term-1')
    expect(listTerminals(wsId).map((t) => t.id)).not.toContain('term-1')
  })
})
