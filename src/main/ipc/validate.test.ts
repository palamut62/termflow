import { describe, it, expect } from 'vitest'
import { createTerminalInput, workspaceExport, parseOrThrow } from './validate'

describe('createTerminalInput', () => {
  const base = { workspaceId: 'w', name: 't', kind: 'cmd' as const }

  it('accepts a valid input', () => {
    const r = createTerminalInput.safeParse({ ...base, cols: 120, rows: 30 })
    expect(r.success).toBe(true)
  })

  it('rejects negative cols', () => {
    const r = createTerminalInput.safeParse({ ...base, cols: -5 })
    expect(r.success).toBe(false)
  })

  it('rejects unknown kind', () => {
    const r = createTerminalInput.safeParse({ ...base, kind: 'bash' })
    expect(r.success).toBe(false)
  })

  it('rejects startupCommand over 4096 chars', () => {
    const r = createTerminalInput.safeParse({ ...base, startupCommand: 'a'.repeat(4097) })
    expect(r.success).toBe(false)
  })

  it('accepts startupCommand at 4096 chars', () => {
    const r = createTerminalInput.safeParse({ ...base, startupCommand: 'a'.repeat(4096) })
    expect(r.success).toBe(true)
  })
})

describe('workspaceExport', () => {
  const valid = {
    schemaVersion: 1,
    workspace: { name: 'W', defaultLayoutMode: 'manual' },
    unknownField: 'kept'
  }

  it('accepts a valid export and passes through unknown fields', () => {
    const r = parseOrThrow(workspaceExport, valid) as Record<string, unknown>
    expect(r.unknownField).toBe('kept')
    // arrays default to []
    expect(r.terminals).toEqual([])
  })

  it('rejects schemaVersion !== 1', () => {
    const r = workspaceExport.safeParse({ ...valid, schemaVersion: 2 })
    expect(r.success).toBe(false)
  })
})
