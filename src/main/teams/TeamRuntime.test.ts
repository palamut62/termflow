import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- child_process / fs mocks --------------------------------------------
let gitRepo = true
let worktreeAddResult = { status: 0, stdout: '', stderr: '' }
const spawned: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end: (value: string) => void }; kill: () => void }> = []

function makeProc(): (typeof spawned)[number] {
  const proc = new EventEmitter() as (typeof spawned)[number]
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { end: vi.fn() }
  proc.kill = vi.fn()
  spawned.push(proc)
  return proc
}

function spawnSyncImpl(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  if (cmd === 'git') {
    if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return { status: gitRepo ? 0 : 1, stdout: 'true\n', stderr: '' }
    if (args[0] === 'worktree' && args[1] === 'add') return worktreeAddResult
    return { status: 0, stdout: 'abc123\n', stderr: '' }
  }
  if (cmd === 'where.exe') {
    const name = args[0]
    return { status: 0, stdout: `C:\\Windows\\System32\\${name}\nC:\\Users\\test\\AppData\\Roaming\\npm\\${name}.cmd\n`, stderr: '' }
  }
  return { status: 1, stdout: '', stderr: '' } // `where <cli>` misses -> resolveCli keeps the name
}

vi.mock('child_process', () => ({
  spawn: () => makeProc(),
  spawnSync: (cmd: string, args: string[]) => spawnSyncImpl(cmd, args)
}))
vi.mock('fs', () => ({ existsSync: () => false, mkdirSync: () => undefined, writeFileSync: () => undefined }))

import { ADAPTERS, providerEnv, TeamRuntime } from './TeamRuntime'
import type { AgentTeamBundle } from '../../shared/types'

describe('agent team runtime adapters', () => {
  it('builds a structured Claude command without shell interpolation', () => {
    const spec = ADAPTERS.claude.build('fix "quoted" input & do not shell-expand', 'review')
    expect(spec.command).toMatch(/cmd\.exe$/i)
    expect(spec.args.some((arg) => /claude\.cmd$/i.test(arg))).toBe(true)
    expect(spec.args).toContain('stream-json')
    expect(spec.args).toContain('plan')
    expect(spec.args).not.toContain('fix "quoted" input & do not shell-expand')
    expect(spec.stdin).toBe('fix "quoted" input & do not shell-expand')
  })

  it('only bypasses codex approvals for the full policy', () => {
    expect(ADAPTERS.codex.build('x', 'review').args).toContain('read-only')
    expect(ADAPTERS.codex.build('x', 'controlled').args).toContain('read-only')
    expect(ADAPTERS.codex.build('x', 'balanced').args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(ADAPTERS.codex.build('x', 'full').args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('parses Claude result and session identity', () => {
    expect(ADAPTERS.claude.parse('{"type":"result","result":"done","session_id":"s1"}')).toEqual({ type: 'result', message: 'done', sessionId: 's1' })
  })

  it('joins Claude assistant text blocks instead of dumping raw JSON', () => {
    expect(ADAPTERS.claude.parse('{"type":"assistant","message":{"content":[{"type":"text","text":"hello "},{"type":"tool_use"},{"type":"text","text":"world"}]},"session_id":"s2"}')).toEqual({ type: 'message', message: 'hello world', sessionId: 's2' })
    expect(ADAPTERS.claude.parse('{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}')).toBeNull()
  })

  it('exposes capability differences for generic CLIs', () => {
    expect(ADAPTERS.claude.structured).toBe(true)
    expect(ADAPTERS.codex.structured).toBe(true)
    expect(ADAPTERS.generic.structured).toBe(false)
  })
})

// --- runtime scheduling / lifecycle --------------------------------------
type TeamStub = AgentTeamBundle
function makeBundle(over: Partial<AgentTeamBundle['team']> = {}, tasks: AgentTeamBundle['tasks'] = []): TeamStub {
  return {
    team: { id: 't1', workspaceId: 'w1', name: 'Team', objective: 'Do it', status: 'draft', permissionPolicy: 'balanced', createdAt: '', updatedAt: '', ...over },
    members: [{ id: 'm1', teamId: 't1', name: 'Dev', role: 'developer', provider: 'claude', status: 'idle' }],
    tasks,
    events: []
  }
}
function makeTask(id: string, over: Partial<AgentTeamBundle['tasks'][number]> = {}): AgentTeamBundle['tasks'][number] {
  return { id, teamId: 't1', title: id, description: '', assigneeId: 'm1', status: 'ready', dependencies: [], acceptanceCriteria: [], updatedAt: '', ...over }
}
function makeRuntime(bundle: TeamStub): TeamRuntime {
  return new TeamRuntime({
    getTeam: () => bundle,
    workspacePath: () => 'C:/ws',
    runtimeRoot: () => 'C:/rt',
    updateTeam: (_id, patch) => Object.assign(bundle.team, patch),
    updateMember: (id, patch) => { const m = bundle.members.find((x) => x.id === id); if (m) Object.assign(m, patch) },
    updateTask: (id, patch) => { const t = bundle.tasks.find((x) => x.id === id); if (t) Object.assign(t, patch) },
    event: () => undefined
  })
}

describe('agent team runtime scheduling', () => {
  beforeEach(() => { gitRepo = true; worktreeAddResult = { status: 0, stdout: '', stderr: '' }; spawned.length = 0 })
  afterEach(() => { delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.AWS_SECRET_ACCESS_KEY })

  it('does not run a task until its dependency completes', () => {
    const bundle = makeBundle({}, [makeTask('a'), makeTask('b', { dependencies: ['a'] })])
    makeRuntime(bundle).start('t1')
    expect(spawned).toHaveLength(1)
    expect(bundle.tasks[0].status).toBe('working')
    expect(bundle.tasks[1].status).toBe('ready')
    spawned[0].emit('close', 0)
    expect(bundle.tasks[0].status).toBe('completed')
    expect(bundle.tasks[1].status).toBe('working')
    expect(spawned).toHaveLength(2)
  })

  it('spawns only one process per task and no-ops a second start', () => {
    const bundle = makeBundle({}, [makeTask('a')])
    const runtime = makeRuntime(bundle)
    runtime.start('t1')
    expect(spawned).toHaveLength(1)
    ;(runtime as unknown as { runTask: (b: TeamStub, t: unknown) => void }).runTask(bundle, bundle.tasks[0])
    runtime.start('t1')
    expect(spawned).toHaveLength(1)
  })

  it('runs team work in a visible PTY terminal when terminal callbacks are available', () => {
    const bundle = makeBundle({}, [makeTask('a')])
    const writeTerminal = vi.fn()
    const runtime = new TeamRuntime({
      getTeam: () => bundle,
      workspacePath: () => 'C:/ws',
      runtimeRoot: () => 'C:/rt',
      updateTeam: (_id, patch) => Object.assign(bundle.team, patch),
      updateMember: (id, patch) => { const member = bundle.members.find((item) => item.id === id); if (member) Object.assign(member, patch) },
      updateTask: (id, patch) => { const task = bundle.tasks.find((item) => item.id === id); if (task) Object.assign(task, patch) },
      event: () => undefined,
      createTerminal: (_team, member) => `pty-${member.id}`,
      writeTerminal
    })
    runtime.start('t1')
    expect(bundle.members[0].terminalId).toBe('pty-m1')
    expect(spawned).toHaveLength(0)
    expect(writeTerminal).toHaveBeenCalledWith('pty-m1', expect.stringContaining('claude -p'))
    runtime.handleTerminalData('pty-m1', 'work completed\r\n__TERMFLOW_DONE_a__\r\n')
    expect(bundle.tasks[0].status).toBe('completed')
    expect(bundle.team.status).toBe('completed')
  })

  it('gates the implementation task on approval under the controlled policy', () => {
    const bundle = makeBundle({ permissionPolicy: 'controlled' }, [makeTask('impl', { title: 'Implement the solution' })])
    makeRuntime(bundle).start('t1')
    expect(spawned).toHaveLength(0)
    expect(bundle.tasks[0].status).toBe('approval')
    expect(bundle.team.status).toBe('running')
  })

  it('hands each provider only its own keys plus strips infra secrets', () => {
    process.env.ANTHROPIC_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.OPENROUTER_API_KEY = 'or'
    process.env.AWS_SECRET_ACCESS_KEY = 'aws'
    const claude = providerEnv('claude')
    expect(claude.ANTHROPIC_API_KEY).toBe('a')
    expect(claude.OPENAI_API_KEY).toBeUndefined()
    expect(claude.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    const codex = providerEnv('codex')
    expect(codex.OPENAI_API_KEY).toBe('o')
    expect(codex.OPENROUTER_API_KEY).toBeUndefined()
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('kills a team running process and drops it from the map on cleanup', () => {
    const bundle = makeBundle({}, [makeTask('a')])
    const runtime = makeRuntime(bundle)
    runtime.start('t1')
    expect(spawned).toHaveLength(1)
    const procs = (runtime as unknown as { processes: Map<string, unknown> }).processes
    expect(procs.size).toBe(1)
    runtime.cleanup('t1', 'C:/ws')
    expect(spawned[0].kill).toHaveBeenCalled()
    expect(procs.size).toBe(0)
  })

  it('pauses active work and makes the task ready to resume', () => {
    const bundle = makeBundle({}, [makeTask('a')])
    const runtime = makeRuntime(bundle)
    runtime.start('t1')
    runtime.pause('t1')
    expect(spawned[0].kill).toHaveBeenCalled()
    expect(bundle.tasks[0].status).toBe('ready')
    expect(bundle.tasks[0].result).toMatch(/paused/i)
    expect(bundle.members[0].status).toBe('idle')
    expect(bundle.team.status).toBe('paused')
  })

  it('stops active work and cancels the team', () => {
    const bundle = makeBundle({}, [makeTask('a')])
    const runtime = makeRuntime(bundle)
    runtime.start('t1')
    runtime.stop('t1')
    expect(spawned[0].kill).toHaveBeenCalled()
    expect(bundle.tasks[0].status).toBe('cancelled')
    expect(bundle.tasks[0].result).toBe('Stopped by the user.')
    expect(bundle.team.status).toBe('cancelled')
  })

  it('fails closed when an isolated worktree cannot be created', () => {
    worktreeAddResult = { status: 1, stdout: '', stderr: 'fatal: boom' }
    const bundle = makeBundle({}, [makeTask('a')])
    expect(() => makeRuntime(bundle).start('t1')).toThrow(/Could not create an isolated Git worktree/)
    expect(bundle.team.status).not.toBe('running')
    expect(spawned).toHaveLength(0)
  })
})
