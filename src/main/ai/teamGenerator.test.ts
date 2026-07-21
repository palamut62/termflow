import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateTeamSpec } from './teamGenerator'

function mockFetchWithContent(content: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] })
  })) as unknown as typeof fetch)
}

const validSpec = JSON.stringify({
  name: 'Test Takımı',
  description: 'Deneme',
  permissionPolicy: 'controlled',
  members: [
    { name: 'Lider', role: 'lead', instructions: 'Koordine et.' },
    { name: 'Geliştirici', role: 'developer', instructions: 'Kod yaz.' }
  ],
  tasks: [
    { title: 'Planla', description: 'Hedefi böl', assigneeIndex: 0, acceptanceCriteria: ['plan hazır'] }
  ]
})

describe('generateTeamSpec', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('geçerli JSON yanıtını AgentTeamTemplate olarak ayrıştırır', async () => {
    mockFetchWithContent(validSpec)
    const tpl = await generateTeamSpec('openrouter', 'key', 'model', 'Bir özellik ekle')
    expect(tpl.name).toBe('Test Takımı')
    expect(tpl.members).toHaveLength(2)
    expect(tpl.tasks[0].assigneeIndex).toBe(0)
    expect(tpl.id).toBeTruthy()
  })

  it('bozuk JSON yanıtında hata fırlatır', async () => {
    mockFetchWithContent('bu json değil {')
    await expect(generateTeamSpec('deepseek', 'key', 'model', 'hedef')).rejects.toThrow()
  })

  it('şema ihlalinde (tek üye) hata fırlatır', async () => {
    mockFetchWithContent(JSON.stringify({ name: 'X', permissionPolicy: 'controlled', members: [{ name: 'A', role: 'lead', instructions: 'x' }], tasks: [] }))
    await expect(generateTeamSpec('openrouter', 'key', 'model', 'hedef')).rejects.toThrow('2-6 üye')
  })

  it('boş alan içeren üyeyi reddeder', async () => {
    mockFetchWithContent(JSON.stringify({ name: 'X', permissionPolicy: 'controlled', members: [{ name: 'A', role: '', instructions: 'x' }, { name: 'B', role: 'dev', instructions: 'y' }], tasks: [] }))
    await expect(generateTeamSpec('openrouter', 'key', 'model', 'hedef')).rejects.toThrow('boş alan')
  })
})
