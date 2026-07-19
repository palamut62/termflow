import * as pty from '@lydell/node-pty'
import { buildClaudeLaunch, verifyClaudeBinary } from './ClaudeBinary'
import { prepareTeamWorktree, providerEnv, type RuntimeCallbacks } from './TeamRuntime'
import { readNativeTeamState, watchTeam, type NativeTeamState } from './NativeBridge'

// Strip ANSI/VT escape sequences so PTY output can be surfaced as plain notes.
// ESC (0x1b) and CSI (0x9b) introduce ANSI/VT sequences; build the matchers
// from char codes to keep control bytes out of the source file.
const ESC = String.fromCharCode(27) + String.fromCharCode(155)
const ANSI_RE = new RegExp(`[${ESC}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><]?`, 'g')
const CTRL_RE = new RegExp('[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', 'g')
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(CTRL_RE, '')
}

interface NativeSession {
  proc: pty.IPty
  ring: string
  lastNoteAt: number
  stopWatch?: () => void
  stopping?: boolean
  // The team dir is created only after the lead acts on the create prompt, so a
  // fresh session must not be treated as "closed" until we've seen it appear.
  seenTeamDir?: boolean
}

const RING_MAX = 8000
const NOTE_THROTTLE_MS = 1000
const PROMPT_DELAY_MS = 1500
const SHUTDOWN_GRACE_MS = 5000

// Native runtime: launches a real Claude Code agent-team lead session over a
// PTY and lets Claude plan/spawn/coordinate teammates itself. TermFlow only
// reads the shared team/task files (via NativeBridge) to mirror state; it never
// writes into ~/.claude.
export class NativeTeamRuntime {
  private sessions = new Map<string, NativeSession>()
  constructor(private callbacks: RuntimeCallbacks) {}

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.stopWatch?.()
      try { session.proc.kill() } catch { /* already gone */ }
    }
    this.sessions.clear()
  }

  start(teamId: string): void {
    const bundle = this.callbacks.getTeam(teamId)
    if (!bundle) throw new Error('Team not found')
    if (this.sessions.has(teamId)) return
    const verify = verifyClaudeBinary()
    if (!verify.ok) {
      this.callbacks.updateTeam(teamId, { status: 'failed' })
      this.callbacks.event({ teamId, type: 'note', message: verify.error })
      throw new Error(verify.error)
    }
    const workspace = this.callbacks.workspacePath(bundle.team.workspaceId)
    if (!workspace) throw new Error('Workspace folder not found')
    const cwd = prepareTeamWorktree(bundle, workspace, this.callbacks)

    const teamName = (bundle.team.nativeTeamName || `termflow-${teamId.slice(0, 10)}`).toLowerCase()
    const env = { ...providerEnv('claude'), CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', TERM: 'xterm-256color' } as { [key: string]: string }
    // node-pty can't spawn a .cmd/.bat/.ps1 shim directly on Windows either, so
    // reuse the same launch builder that verifyClaudeBinary used.
    const launch = buildClaudeLaunch(verify.path, ['--teammate-mode', 'in-process'])
    const proc = pty.spawn(launch.command, launch.args, { cwd, env, cols: 200, rows: 50 })
    const session: NativeSession = { proc, ring: '', lastNoteAt: 0 }
    this.sessions.set(teamId, session)
    this.callbacks.updateTeam(teamId, { status: 'running', nativeTeamName: teamName })

    proc.onData((data) => this.onData(teamId, data))
    proc.onExit(() => {
      const current = this.sessions.get(teamId)
      if (!current || current.proc !== proc) return
      current.stopWatch?.()
      this.sessions.delete(teamId)
      const bundleNow = this.callbacks.getTeam(teamId)
      if (bundleNow && bundleNow.team.status === 'running' && !current.stopping) {
        this.callbacks.updateTeam(teamId, { status: 'failed' })
        this.callbacks.event({ teamId, type: 'runtime.lost', message: 'The native Claude session exited unexpectedly.' })
      }
    })

    // Give the CLI a moment to boot, then instruct the lead to create the team.
    const objective = bundle.team.objective
    setTimeout(() => {
      if (this.sessions.get(teamId) !== session) return
      const prompt = `Create an agent team named exactly '${teamName}'. Objective: ${objective}. Plan the work yourself, spawn teammates as needed, coordinate via the shared task list, and shut the team down when the objective is complete.`
      try { proc.write(`${prompt}\r`) } catch { /* session gone */ }
    }, PROMPT_DELAY_MS)

    // Start the read-only state bridge.
    session.stopWatch = watchTeam(teamName, (state) => this.applyState(teamId, teamName, state))
  }

  private onData(teamId: string, data: string): void {
    const session = this.sessions.get(teamId)
    if (!session) return
    session.ring = (session.ring + data).slice(-RING_MAX)
    const now = Date.now()
    if (now - session.lastNoteAt < NOTE_THROTTLE_MS) return
    const clean = stripAnsi(data).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 1)
    const line = clean[clean.length - 1]
    if (!line) return
    session.lastNoteAt = now
    this.callbacks.event({ teamId, type: 'note', message: line.slice(0, 500) })
  }

  private applyState(teamId: string, teamName: string, state: NativeTeamState): void {
    if (state.parseError) return
    const session = this.sessions.get(teamId)
    // The lead creates the team dir only after acting on the prompt. Until we've
    // observed it appear (or any members/tasks), never treat the team as done —
    // otherwise a brand-new session finalizes on its first empty poll.
    if (session && (state.exists || state.members.length > 0 || state.tasks.length > 0)) session.seenTeamDir = true
    this.callbacks.syncNativeState?.(teamId, state)
    const seen = session ? session.seenTeamDir === true : false
    const closedOrGone = state.closed || (seen && !state.exists) // shut down in config, or dir appeared then was removed
    const done = seen && closedOrGone && (state.tasks.length === 0 || state.tasks.every((t) => (t.status || '').toLowerCase() === 'completed'))
    if (done) {
      const bundle = this.callbacks.getTeam(teamId)
      if (bundle && bundle.team.status === 'running') {
        this.callbacks.updateTeam(teamId, { status: 'completed' })
        this.callbacks.event({ teamId, type: 'note', message: 'The native agent team completed its objective.' })
        if (session) { session.stopping = true; session.stopWatch?.(); try { session.proc.write('Shut down the team and exit.\r') } catch { /* gone */ } }
      }
    }
  }

  sendMessage(teamId: string, text: string): void {
    const session = this.sessions.get(teamId)
    if (!session) throw new Error('Native runtime is not running.')
    session.proc.write(`${text}\r`)
  }

  stop(teamId: string): void {
    const session = this.sessions.get(teamId)
    if (session) {
      session.stopping = true
      try { session.proc.write('Shut down the team and exit.\r') } catch { /* gone */ }
      const proc = session.proc
      setTimeout(() => { try { proc.kill() } catch { /* already exited */ } }, SHUTDOWN_GRACE_MS)
      session.stopWatch?.()
      this.sessions.delete(teamId)
    }
    this.callbacks.updateTeam(teamId, { status: 'cancelled' })
  }

  // On app startup a team marked 'running' but with no live PTY cannot be
  // reattached (the CLI child died with the previous process).
  reattachCheck(teamId: string): void {
    if (this.sessions.has(teamId)) return
    const bundle = this.callbacks.getTeam(teamId)
    if (!bundle || bundle.team.status !== 'running') return
    this.callbacks.updateTeam(teamId, { status: 'failed' })
    this.callbacks.event({ teamId, type: 'runtime.lost', message: 'Native runtime was lost (app restarted); the team cannot be reattached.' })
  }
}

export { readNativeTeamState }
