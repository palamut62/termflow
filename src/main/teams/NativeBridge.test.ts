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

import { findNewSessionDir, parseDoneSentinel, parseTaskFile, parseTeamConfig, readNativeTeamState, readSessionTasks, snapshotSessionDirs } from './NativeBridge'

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

describe('session-dir discovery (Claude Code 2.1.x layout)', () => {
  it('diffs a baseline snapshot to find the newly created session dir', () => {
    const tasksRoot = join(fakeHome, '.claude', 'tasks')
    mkdirSync(join(tasksRoot, 'session-old0000'), { recursive: true })
    const baseline = snapshotSessionDirs()
    expect(baseline.has('session-old0000')).toBe(true)
    mkdirSync(join(tasksRoot, 'session-new1111'), { recursive: true })
    expect(findNewSessionDir(baseline)).toBe('session-new1111')
  })

  it('reads session tasks, skipping .lock/.highwatermark and non-JSON files', () => {
    const dir = join(fakeHome, '.claude', 'tasks', 'session-read2222')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 'First', status: 'in_progress', owner: 'smoke-writer' }))
    writeFileSync(join(dir, '2.json'), JSON.stringify({ id: '2', subject: 'Second', status: 'completed' }))
    writeFileSync(join(dir, '.highwatermark'), '2')
    writeFileSync(join(dir, '.lock'), '')
    const { tasks, parseError } = readSessionTasks('session-read2222')
    expect(parseError).toBe(false)
    expect(tasks.map((t) => t.title).sort()).toEqual(['First', 'Second'])
    expect(tasks.find((t) => t.title === 'First')?.owner).toBe('smoke-writer')
  })

  it('surfaces session tasks via readNativeTeamState when the legacy teams dir is absent', () => {
    const dir = join(fakeHome, '.claude', 'tasks', 'session-live3333')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', subject: 'Write file', status: 'in_progress' }))
    const state = readNativeTeamState('no-such-team', 'session-live3333')
    expect(state.exists).toBe(true)
    expect(state.sessionDir).toBe('session-live3333')
    expect(state.tasks).toHaveLength(1)
    expect(state.closed).toBe(false)
  })
})

describe('completion sentinel parsing', () => {
  it('extracts a summary from JSON, tolerating unknown fields', () => {
    expect(parseDoneSentinel(JSON.stringify({ summary: 'All done', extra: 1 })).summary).toBe('All done')
    expect(parseDoneSentinel(JSON.stringify({ outcome: 'Fallback key' })).summary).toBe('Fallback key')
  })

  it('falls back to trimmed text on malformed JSON without throwing', () => {
    expect(parseDoneSentinel('  just text  ').summary).toBe('just text')
  })
})
