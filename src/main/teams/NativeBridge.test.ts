import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// readNativeTeamState resolves paths under os.homedir(); point it at a temp dir.
const fakeHome = mkdtempSync(join(tmpdir(), 'tf-native-'))
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => fakeHome }
})

import { parseTaskFile, parseTeamConfig, readNativeTeamState } from './NativeBridge'

describe('native team config parsing', () => {
  it('extracts members and lead from a config, tolerating unknown fields', () => {
    const raw = JSON.stringify({
      name: 'termflow-abc', unknownField: 42,
      members: [
        { name: 'Lead', role: 'lead', status: 'working', extra: true },
        { id: 'dev-1', role: 'developer', state: 'idle' }
      ]
    })
    const { members, closed } = parseTeamConfig(raw)
    expect(closed).toBe(false)
    expect(members).toHaveLength(2)
    expect(members[0]).toMatchObject({ name: 'Lead', lead: true, status: 'working' })
    expect(members[1]).toMatchObject({ name: 'dev-1', id: 'dev-1', lead: false })
  })

  it('reads members from alternate array keys and detects a closed team', () => {
    const { members, closed } = parseTeamConfig(JSON.stringify({ status: 'completed', teammates: [{ name: 'X' }] }))
    expect(members).toHaveLength(1)
    expect(closed).toBe(true)
  })

  it('throws on malformed config JSON (caller catches)', () => {
    expect(() => parseTeamConfig('{ not json')).toThrow()
  })
})

describe('native task parsing', () => {
  it('maps subject/description/status defensively', () => {
    const t = parseTaskFile(JSON.stringify({ id: 't1', subject: 'Do work', description: 'details', status: 'in_progress', owner: 'Lead', blockedBy: ['t0'] }))
    expect(t).toMatchObject({ id: 't1', title: 'Do work', description: 'details', status: 'in_progress', owner: 'Lead', blockedBy: ['t0'] })
  })

  it('falls back to a title when only description is present', () => {
    expect(parseTaskFile(JSON.stringify({ description: 'just a body' })).title).toBe('just a body')
  })
})

describe('readNativeTeamState', () => {
  const team = 'termflow-test'
  afterEach(() => vi.restoreAllMocks())

  it('normalizes members and tasks from disk without crashing on bad files', () => {
    const teamDir = join(fakeHome, '.claude', 'teams', team)
    const tasksDir = join(fakeHome, '.claude', 'tasks', team)
    mkdirSync(teamDir, { recursive: true })
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(join(teamDir, 'config.json'), JSON.stringify({ members: [{ name: 'Lead', role: 'lead' }] }))
    writeFileSync(join(tasksDir, 'a.json'), JSON.stringify({ id: 'a', title: 'Task A', status: 'completed' }))
    writeFileSync(join(tasksDir, 'bad.json'), '{ broken')
    writeFileSync(join(tasksDir, 'ignore.txt'), 'nope')

    const state = readNativeTeamState(team)
    expect(state.exists).toBe(true)
    expect(state.members).toEqual([{ name: 'Lead', id: undefined, status: undefined, lead: true }])
    expect(state.tasks.find((t) => t.title === 'Task A')).toBeTruthy()
    expect(state.parseError).toBe(true) // bad.json flagged, but did not throw
  })

  it('reports a missing team directory as not-exists and not-closed', () => {
    // A brand-new team whose dir has not been created yet must NOT look closed,
    // or the runtime would finalize it before the lead ever starts working.
    const state = readNativeTeamState('does-not-exist')
    expect(state.exists).toBe(false)
    expect(state.closed).toBe(false)
    expect(state.members).toEqual([])
    expect(state.tasks).toEqual([])
  })

  it('marks closed only when the config itself reports shutdown', () => {
    const closedTeam = 'termflow-closed'
    const dir = join(fakeHome, '.claude', 'teams', closedTeam)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ status: 'completed', members: [{ name: 'Lead', role: 'lead' }] }))
    const state = readNativeTeamState(closedTeam)
    expect(state.exists).toBe(true)
    expect(state.closed).toBe(true)
  })
})
