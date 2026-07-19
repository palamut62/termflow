// Live smoke test for the native Agent Teams runtime. Run with: npx tsx smoke-native.mts
// Spawns a real Claude Code lead session in a temp git repo and mirrors bridge state.
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { NativeTeamRuntime } from './src/main/teams/NativeTeamRuntime'
import type { AgentTeamBundle } from './src/shared/types'

const ts = (): string => new Date().toISOString().slice(11, 19)
const log = (...a: unknown[]): void => console.log(ts(), ...a)

const ws = mkdtempSync(join(tmpdir(), 'tf-smoke-ws-'))
const runtimeRoot = mkdtempSync(join(tmpdir(), 'tf-smoke-rt-'))
writeFileSync(join(ws, 'README.md'), '# smoke\n')
for (const args of [['init'], ['add', '.'], ['-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-m', 'init']]) {
  const r = spawnSync('git', args, { cwd: ws, encoding: 'utf8' })
  if (r.status !== 0) { console.error('git failed', args, r.stderr); process.exit(1) }
}
log('workspace:', ws)

const teamId = 'smoke' + Math.random().toString(36).slice(2, 7)
const bundle: AgentTeamBundle = {
  team: { id: teamId, workspaceId: 'w1', name: 'smoke', objective: "Create a file named SMOKE.txt containing exactly the word ok in the current directory, then shut down the team.", status: 'draft', permissionPolicy: 'balanced', runtimeType: 'native', createdAt: '', updatedAt: '' },
  members: [{ id: 'm1', teamId, name: 'Team Lead', role: 'lead', provider: 'claude', status: 'idle' }],
  tasks: [], events: []
}

const runtime = new NativeTeamRuntime({
  getTeam: () => bundle,
  workspacePath: () => ws,
  runtimeRoot: () => runtimeRoot,
  updateTeam: (_id, patch) => { Object.assign(bundle.team, patch); log('TEAM', JSON.stringify(patch)) },
  updateMember: (_id, patch) => log('MEMBER', JSON.stringify(patch)),
  updateTask: (_id, patch) => log('TASK', JSON.stringify(patch)),
  event: (input) => log('EVENT', input.type, input.message.slice(0, 220)),
  syncNativeState: (_id, state) => log('SYNC', JSON.stringify(state).slice(0, 400))
})

runtime.start(teamId)
const teamName = bundle.team.nativeTeamName!
log('teamName:', teamName, 'status:', bundle.team.status)

// Debug visibility: peek at the private PTY session ring and auto-accept
// blocking interactive prompts (folder trust / theme pickers) with Enter.
const sessions = (runtime as unknown as { sessions: Map<string, { proc: { write(d: string): void }; ring: string }> }).sessions
const ESCJ = String.fromCharCode(27)
const strip = (s: string): string => s.replace(new RegExp(`${ESCJ}\\[[0-9;?]*[a-zA-Z]|${ESCJ}\\][^${String.fromCharCode(7)}]*${String.fromCharCode(7)}|[^\\x20-\\x7e\\n]`, 'g'), '')
let accepted = 0
let elapsed = 0
const iv = setInterval(() => {
  elapsed += 5
  const session = sessions.get(teamId)
  if (session) {
    const screen = strip(session.ring).split('\n').map((l) => l.trim()).filter(Boolean).slice(-14)
    console.log('----- screen tail -----\n' + screen.join('\n') + '\n-----------------------')
    const text = screen.join(' ').toLowerCase()
    const teamDirMissing = !existsSync(join(homedir(), '.claude', 'teams', teamName))
    if (accepted < 5 && elapsed >= 20 && elapsed % 15 === 0 && teamDirMissing && text.length > 0) {
      log('AUTO-ENTER (nudge: team dir still missing)')
      session.proc.write('\r')
      accepted++
    } else if (accepted < 3 && /trust|proceed|dark mode|light mode|press enter|choose|select/.test(text)) {
      log('AUTO-ENTER (prompt detected)')
      session.proc.write('\r')
      accepted++
    }
  }
  const wt = bundle.team.worktreePath
  const smoke = wt && existsSync(join(wt, 'SMOKE.txt'))
  const teamDir = existsSync(join(homedir(), '.claude', 'teams', teamName))
  log(`t=${elapsed}s status=${bundle.team.status} teamDir=${teamDir} SMOKE.txt=${smoke ? JSON.stringify(readFileSync(join(wt!, 'SMOKE.txt'), 'utf8')) : false}`)
  if (bundle.team.status === 'completed' || bundle.team.status === 'failed' || elapsed >= 360) {
    log('FINAL status=', bundle.team.status, 'SMOKE.txt=', smoke)
    clearInterval(iv)
    runtime.dispose()
    setTimeout(() => process.exit(0), 1000)
  }
}, 5000)
