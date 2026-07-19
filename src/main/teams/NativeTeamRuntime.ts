import * as pty from '@lydell/node-pty'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { buildClaudeLaunch, verifyClaudeBinary } from './ClaudeBinary'
import { prepareTeamWorktree, providerEnv, type RuntimeCallbacks } from './TeamRuntime'
import { parseDoneSentinel, readNativeTeamState, snapshotSessionDirs, watchTeam, type NativeTeamState } from './NativeBridge'

// The lead writes this file in its cwd as the final step; it is the primary
// completion signal because task JSONs are deleted as tasks finish.
const DONE_SENTINEL = '.termflow-team-done.json'

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
  cwd: string
  ring: string
  lastNoteAt: number
  stopWatch?: () => void
  stopping?: boolean
  // The task/team dir is created only after the lead acts on the create prompt,
  // so a fresh session must not be treated as "closed" until it is discovered.
  seenTeamDir?: boolean
  // Set only once real tasks/members are observed; gates the prompt retries
  // (the session task dir itself is created at CLI boot and proves nothing).
  seenWork?: boolean
  finished?: boolean
}

const RING_MAX = 8000
const NOTE_THROTTLE_MS = 1000
const PROMPT_DELAY_MS = 3000
const SHUTDOWN_GRACE_MS = 5000
const PROMPT_RETRY_MS = 20000
const PROMPT_MAX_ATTEMPTS = 6

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
    // Map the team policy to a CLI permission mode; the default (manual
    // approvals) would stall every team tool call waiting for a user click.
    const policy = bundle.team.permissionPolicy
    const permissionMode = policy === 'review' ? 'plan' : policy === 'full' ? 'bypassPermissions' : 'acceptEdits'
    const launch = buildClaudeLaunch(verify.path, ['--teammate-mode', 'in-process', '--permission-mode', permissionMode])
    // Snapshot existing task session dirs BEFORE spawning so the bridge can
    // diff-detect the new session-<hex> dir this run creates.
    const baseline = snapshotSessionDirs()
    const proc = pty.spawn(launch.command, launch.args, { cwd, env, cols: 200, rows: 50 })
    const session: NativeSession = { proc, cwd, ring: '', lastNoteAt: 0 }
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

    // Instruct the lead to create the team. The interactive TUI can be showing
    // startup dialogs (folder trust, MCP selection) that swallow early input,
    // and it drops a carriage return sent in the same chunk as the text — so:
    // write the text, submit with a delayed Enter, and keep re-sending until
    // the bridge sees the team dir appear (the Enter also accepts the safe
    // defaults of any startup dialog that ate the previous attempt).
    const objective = bundle.team.objective
    const prompt = `Create an agent team named exactly '${teamName}'. Objective: ${objective}. Plan the work yourself, spawn teammates as needed, coordinate via the shared task list, and shut the team down when the objective is complete. When the objective is fully complete and you have shut the team down, write a file named exactly '${DONE_SENTINEL}' in the current working directory containing JSON: {"summary": "<one-paragraph outcome>"}. Do this as the very last step.`
    let attempts = 0
    const sendPrompt = (): void => {
      if (this.sessions.get(teamId) !== session || session.seenWork || session.stopping) return
      if (attempts++ >= PROMPT_MAX_ATTEMPTS) {
        this.callbacks.event({ teamId, type: 'note', message: 'The lead session did not create the team (startup dialogs may need attention). Use the message box to talk to it directly.' })
        return
      }
      try { proc.write(prompt) } catch { return }
      setTimeout(() => { if (this.sessions.get(teamId) === session) { try { proc.write('\r') } catch { /* gone */ } } }, 600)
      setTimeout(sendPrompt, PROMPT_RETRY_MS)
    }
    setTimeout(sendPrompt, PROMPT_DELAY_MS)

    // Start the read-only state bridge (discovers the session dir vs. baseline).
    session.stopWatch = watchTeam(teamName, baseline, (state) => this.applyState(teamId, teamName, state))
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
    if (!session || session.finished) return
    // The task/team dir is created only after the lead acts on the prompt. Until
    // it (or any member/task) is discovered, never treat the team as done — else
    // a brand-new session finalizes on its first empty poll.
    if (state.exists || state.members.length > 0 || state.tasks.length > 0) session.seenTeamDir = true
    // The CLI creates its session task dir at boot, before the prompt is even
    // accepted — so `exists` alone doesn't prove the lead got the objective.
    // Only actual tasks (or a legacy team config member list) stop the retries.
    if (state.tasks.length > 0 || state.members.length > 0) session.seenWork = true
    this.callbacks.syncNativeState?.(teamId, state)

    // Primary completion signal: the lead's sentinel file. Task JSONs are
    // deleted as they finish, so an empty task dir alone is not conclusive.
    const sentinel = join(session.cwd, DONE_SENTINEL)
    if (existsSync(sentinel)) {
      let summary = ''
      try { summary = parseDoneSentinel(readFileSync(sentinel, 'utf8')).summary } catch { /* keep empty */ }
      this.finishTeam(teamId, summary || 'The native agent team completed its objective.')
      return
    }

    // Fallback: a legacy team config that explicitly reports shutdown.
    if (session.seenTeamDir && state.closed && state.tasks.every((t) => (t.status || '').toLowerCase() === 'completed')) {
      this.finishTeam(teamId, 'The native agent team completed its objective.')
    }
  }

  private finishTeam(teamId: string, summary: string): void {
    const session = this.sessions.get(teamId)
    const bundle = this.callbacks.getTeam(teamId)
    if (!bundle || bundle.team.status !== 'running') return
    if (session) session.finished = true
    // Task files are transient, so mark any still-open synced tasks completed.
    this.callbacks.completeOpenNativeTasks?.(teamId)
    this.callbacks.updateTeam(teamId, { status: 'completed' })
    this.callbacks.event({ teamId, type: 'note', message: summary.slice(0, 500) })
    if (session) { session.stopping = true; session.stopWatch?.(); try { session.proc.write('Shut down the team and exit.\r') } catch { /* gone */ } }
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
