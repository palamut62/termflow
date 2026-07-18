import { describe, expect, it } from 'vitest'
import { ADAPTERS } from './TeamRuntime'

describe('agent team runtime adapters', () => {
  it('builds a structured Claude command without shell interpolation', () => {
    const spec = ADAPTERS.claude.build('fix "quoted" input & do not shell-expand', 'review')
    expect(spec.command).toBe('claude')
    expect(spec.args).toContain('stream-json')
    expect(spec.args).toContain('plan')
    expect(spec.args).toContain('fix "quoted" input & do not shell-expand')
  })

  it('parses Claude result and session identity', () => {
    expect(ADAPTERS.claude.parse('{"type":"result","result":"done","session_id":"s1"}')).toEqual({ type: 'result', message: 'done', sessionId: 's1' })
  })

  it('exposes capability differences for generic CLIs', () => {
    expect(ADAPTERS.claude.structured).toBe(true)
    expect(ADAPTERS.codex.structured).toBe(true)
    expect(ADAPTERS.generic.structured).toBe(false)
  })
})
