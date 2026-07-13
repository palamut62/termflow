import { afterEach, describe, expect, it } from 'vitest'
import { resolveShell } from './shells'

describe('resolveShell provider isolation', () => {
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL

  afterEach(() => {
    if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl
  })

  it('removes inherited provider routing from standalone agents', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example'

    const resolved = resolveShell({
      workspaceId: 'workspace',
      name: 'Claude Code',
      kind: 'claude',
      cleanProviderEnv: true,
      startupCommand: 'claude'
    })

    expect(resolved.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('keeps explicit provider routing for provider-backed terminals', () => {
    const resolved = resolveShell({
      workspaceId: 'workspace',
      name: 'DeepSeek',
      kind: 'custom',
      cleanProviderEnv: false,
      env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
      startupCommand: 'claude'
    })

    expect(resolved.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
  })
})
