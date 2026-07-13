import * as pty from '@lydell/node-pty'
import type { WebContents } from 'electron'
import type { CreateTerminalInput, RenderMode } from '../../shared/types'
import { IPC } from '../../shared/types'
import { resolveShell } from './shells'

const ACTIVE_INTERVAL_MS = 16 // PRD §11.6 IPC batching for the focused terminal
const DEFAULT_SCROLLBACK_LINES = 10000 // PRD §10.9.1
const MAX_RECORDING_MS = 30 * 60 * 1000 // recording buffer cap: 30 minutes
const MAX_RECORDING_BYTES = 50 * 1024 * 1024 // recording buffer cap: 50MB

// Error/activity detection patterns (PRD §10.9.5)
const ERROR_RE = /\b(error|exception|failed|fatal|traceback|npm ERR|ModuleNotFound|SyntaxError|TypeError|Permission denied)\b/i

// Confirmation-prompt detection for the "agent awaiting approval" desktop
// notification — matches common y/n and tool-permission style prompts.
const AWAITING_RE = /(\(y\/n\)|\[y\/n\]|yes\/no|do you want to proceed|do you want to continue|allow this action|press enter to continue|waiting for (?:approval|confirmation)|confirm\?)/i

// OSC 7 "current working directory" escape sequence, emitted by most modern
// shells (bash/zsh/pwsh prompts, VS Code shell integration, etc.) on every
// prompt redraw: ESC ] 7 ; file://<host>/<path> BEL|ST (deep git / cwd tracking)
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/

// Agent-to-agent routing loop/echo guards. Routing writes one process's output
// into another's input, so an A->B->A topology (or a terminal echoing its own
// input) can otherwise spin into an infinite feedback loop.
const CONTINUOUS_THROTTLE_MS = 80 // min gap between continuous flushes per connection
const ROUTE_ECHO_WINDOW_MS = 4000 // remember recently-injected payloads this long
const ROUTE_ECHO_MAX_ENTRIES = 200 // cap remembered inbound signatures per terminal
const ROUTE_LOOP_WINDOW_MS = 1500 // sliding window for the route-rate backstop
const ROUTE_LOOP_MAX = 40 // max routes per connection in the window before we cut
const ROUTE_QUEUE_MAX_BYTES = 64 * 1024 // cap the continuous accumulation buffer

export interface RoutingRule {
  connectionId: string
  targetTerminalIds: string[]
  triggerPattern: string // regex source
  transform?: string
  routeBehavior: 'marker' | 'continuous'
}

export interface RecordingEntry {
  ts: number // ms since start
  data: string
}

interface ManagedPty {
  id: string
  proc: pty.IPty
  input: CreateTerminalInput
  buffer: string[]
  bufferLines: number
  totalEmitted: number
  pending: string
  flushTimer: NodeJS.Timeout | null
  exited: boolean
  exitCode?: number
  mode: RenderMode
  errorSignalled: boolean
  awaitingSignalled: boolean
  createdAt: number
  cwd: string
  routingRules?: RoutingRule[]
  // Regex compiled once per setRouting() call (per-chunk compilation is costly
  // and a ReDoS vector). null `re` means the rule's pattern was invalid/skipped.
  compiledRules?: { rule: RoutingRule; re: RegExp | null }[]
  startupTimer: NodeJS.Timeout | null
  startupPending: boolean
  lastRouteAt: Map<string, number>
  // Routing loop/echo protection + continuous queue (per connection)
  recentInbound: { sig: string; at: number }[] // payloads recently injected INTO this pty
  routeHops: Map<string, number[]> // connectionId -> recent route timestamps (loop backstop)
  routeQueues: Map<string, { buf: string; timer: NodeJS.Timeout | null }> // continuous accumulation
  loopWarned: Set<string> // connectionIds already warned about (avoids log spam)
  // Recording
  recording: boolean
  recordingStart: number
  recordedChunks: RecordingEntry[]
  recordedBytes: number
}

/**
 * Owns all node-pty processes. Output is batched to the renderer at a cadence
 * that depends on each terminal's render mode:
 *   active  -> 16ms live stream
 *   passive -> throttled (configurable, default 250ms)
 *   buffer  -> not streamed at all; the renderer rehydrates from the ring
 *              buffer when the terminal becomes visible again.
 * A bounded ring buffer per terminal keeps memory flat. (PRD §11, §12, §13.5)
 */
export class PtyManager {
  private terminals = new Map<string, ManagedPty>()
  private maxLines = DEFAULT_SCROLLBACK_LINES
  private passiveIntervalMs = 250

  constructor(private getSender: () => WebContents | null) {}

  create(id: string, input: CreateTerminalInput): { pid: number } {
    if (this.terminals.has(id)) this.kill(id)

    const resolved = resolveShell(input)
    const proc = pty.spawn(resolved.shell, resolved.args, {
      name: 'xterm-256color',
      cols: input.cols ?? 120,
      rows: input.rows ?? 30,
      cwd: resolved.cwd,
      env: resolved.env,
      useConpty: true
    })

    const managed: ManagedPty = {
      id,
      proc,
      input,
      buffer: [],
      bufferLines: 0,
      totalEmitted: 0,
      pending: '',
      flushTimer: null,
      exited: false,
      mode: 'active',
      errorSignalled: false,
      awaitingSignalled: false,
      createdAt: Date.now(),
      cwd: resolved.cwd,
      startupTimer: null,
      startupPending: !!input.startupCommand,
      lastRouteAt: new Map(),
      recentInbound: [],
      routeHops: new Map(),
      routeQueues: new Map(),
      loopWarned: new Set(),
      recording: false,
      recordingStart: 0,
      recordedChunks: [],
      recordedBytes: 0
    }
    this.terminals.set(id, managed)

    proc.onData((data) => this.onData(managed, data))
    proc.onExit(({ exitCode }) => {
      managed.exited = true
      managed.exitCode = exitCode
      this.flush(managed, true)
      const durationMs = Date.now() - managed.createdAt
      this.getSender()?.send(IPC.PTY_EXIT, { id, exitCode, durationMs })
      // Release the heavy per-terminal routing/echo state now that the process
      // is gone. `buffer` is intentionally kept so the renderer can rehydrate.
      managed.recentInbound = []
      managed.routeHops.clear()
      managed.loopWarned.clear()
      for (const q of managed.routeQueues.values()) if (q.timer) clearTimeout(q.timer)
      managed.routeQueues.clear()
    })

    // Wait for the renderer to report the real xterm dimensions before
    // starting full-screen TUIs. Drawing at the 120x30 spawn default and then
    // shrinking corrupts ConPTY's wrapped buffer (broken Claude/Codex borders).
    // The fallback keeps headless/background terminals from waiting forever.
    if (input.startupCommand) {
      managed.startupTimer = setTimeout(() => {
        managed.startupTimer = null
        this.startStartupCommand(managed)
      }, 5000)
    }

    return { pid: proc.pid }
  }

  private countNewlines(s: string): number {
    let n = 0
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
    return n
  }

  private onData(managed: ManagedPty, data: string): void {
    managed.totalEmitted += data.length
    // Ring buffer (single-pass newline count, also cap chunk count). PRD §11.8
    managed.buffer.push(data)
    managed.bufferLines += this.countNewlines(data)
    while (managed.buffer.length > 1 && (managed.bufferLines > this.maxLines || managed.buffer.length > this.maxLines)) {
      const removed = managed.buffer.shift()!
      managed.bufferLines -= this.countNewlines(removed)
    }

    // Recording (bounded by duration and total size to keep memory flat)
    if (managed.recording) {
      const elapsed = Date.now() - managed.recordingStart
      const nextBytes = managed.recordedBytes + Buffer.byteLength(data, 'utf8')
      if (elapsed > MAX_RECORDING_MS || nextBytes > MAX_RECORDING_BYTES) {
        managed.recording = false
        this.getSender()?.send(IPC.REC_LIMIT, {
          id: managed.id,
          reason: elapsed > MAX_RECORDING_MS ? 'duration' : 'size'
        })
      } else {
        managed.recordedChunks.push({ ts: elapsed, data })
        managed.recordedBytes = nextBytes
      }
    }

    // OSC 7 cwd tracking — shells report their cwd on every prompt redraw, so
    // we pick up `cd`s without polling. (deep git / cwd tracking)
    let osc7Match: RegExpExecArray | null
    const osc7Re = new RegExp(OSC7_RE.source, 'g')
    let lastPath: string | null = null
    while ((osc7Match = osc7Re.exec(data)) !== null) lastPath = osc7Match[1]
    if (lastPath) {
      try {
        const decoded = decodeURIComponent(lastPath)
        // Windows paths arrive as /C:/Users/... over the file:// URI — strip the leading slash.
        const normalized = /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded
        if (normalized && normalized !== managed.cwd) {
          managed.cwd = normalized
          this.getSender()?.send(IPC.PTY_CWD, { id: managed.id, cwd: normalized })
        }
      } catch {
        /* malformed OSC 7 payload */
      }
    }

    // Error/activity detection — signal once until cleared. PRD §10.9.5
    if (!managed.errorSignalled && ERROR_RE.test(data)) {
      managed.errorSignalled = true
      this.getSender()?.send(IPC.PTY_ACTIVITY, { id: managed.id, error: true })
    }

    // Confirmation-prompt detection — signal once until the user responds
    // (cleared on the next write() to this terminal, see below).
    if (!managed.awaitingSignalled && AWAITING_RE.test(data)) {
      managed.awaitingSignalled = true
      this.getSender()?.send(IPC.PTY_AWAITING, { id: managed.id })
    }

    // Agent-to-agent routing (opt-in). Continuous routing is intentionally
    // sanitized and rate-limited because it writes process output into another
    // process input stream.
    if (managed.compiledRules?.length) {
      for (const { rule, re } of managed.compiledRules) {
        if (rule.routeBehavior === 'continuous') {
          const clean = this.sanitizeRouteData(data)
          if (!clean.trim()) continue
          // Never drop: accumulate into a per-connection queue and flush on a
          // throttle. Loop/echo checks run at flush time (single point).
          this.enqueueContinuous(managed, rule, clean)
        } else if (re) {
          // 'gs' regex is stateful (lastIndex) — reset before each chunk scan.
          re.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = re.exec(data)) !== null) {
            let output = match[0]
            if (rule.transform) {
              output = rule.transform.replace(/\$(\d+)/g, (_, n) => match![parseInt(n)] || '')
            }
            output = this.sanitizeRouteData(output).slice(0, 4000)
            if (!output.trim()) continue
            if (this.shouldBlockRoute(managed, rule.connectionId, output)) continue
            for (const tid of rule.targetTerminalIds) {
              this.write(tid, output + '\r')
              this.recordInbound(tid, output)
            }
            this.emitRoute(rule.connectionId)
          }
        }
      }
    }

    if (managed.mode === 'buffer') return // no streaming while offscreen/minimized

    managed.pending += data
    if (!managed.flushTimer) {
      const interval = managed.mode === 'active' ? ACTIVE_INTERVAL_MS : this.passiveIntervalMs
      managed.flushTimer = setTimeout(() => this.flush(managed), interval)
    }
  }

  private sanitizeRouteData(data: string): string {
    return data
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  }

  // ---- Routing loop/echo protection ----

  /** Whitespace-collapsed, bounded signature used to match echoed payloads. */
  private routeSignature(s: string): string {
    return s.replace(/\s+/g, ' ').trim().slice(0, 200)
  }

  /** Remember a payload we just injected into `targetId`'s input stream. */
  private recordInbound(targetId: string, payload: string): void {
    const t = this.terminals.get(targetId)
    if (!t) return
    const sig = this.routeSignature(payload)
    if (!sig) return
    const now = Date.now()
    t.recentInbound.push({ sig, at: now })
    while (t.recentInbound.length && now - t.recentInbound[0].at > ROUTE_ECHO_WINDOW_MS) t.recentInbound.shift()
    if (t.recentInbound.length > ROUTE_ECHO_MAX_ENTRIES)
      t.recentInbound.splice(0, t.recentInbound.length - ROUTE_ECHO_MAX_ENTRIES)
  }

  /**
   * True when `managed`'s outgoing payload is really an echo of something that
   * was recently routed INTO it — i.e. the tail of an A->B->A feedback loop.
   */
  private isEcho(managed: ManagedPty, payload: string): boolean {
    const sig = this.routeSignature(payload)
    if (!sig) return false
    const now = Date.now()
    return managed.recentInbound.some(
      (e) => now - e.at <= ROUTE_ECHO_WINDOW_MS && (e.sig === sig || e.sig.includes(sig) || sig.includes(e.sig))
    )
  }

  /** Rate backstop: too many routes over one connection in a short window. */
  private isLoop(managed: ManagedPty, connectionId: string): boolean {
    const now = Date.now()
    const recent = (managed.routeHops.get(connectionId) ?? []).filter((t) => now - t <= ROUTE_LOOP_WINDOW_MS)
    recent.push(now)
    managed.routeHops.set(connectionId, recent)
    return recent.length > ROUTE_LOOP_MAX
  }

  private warnLoop(managed: ManagedPty, connectionId: string, reason: string): void {
    if (managed.loopWarned.has(connectionId)) return
    managed.loopWarned.add(connectionId)
    console.warn(
      `[PtyManager] routing loop guard (${reason}) tripped for connection ${connectionId} from terminal ${managed.id}; suppressing route.`
    )
  }

  /** Combined echo + rate guard. Returns true when the route must be cut. */
  private shouldBlockRoute(managed: ManagedPty, connectionId: string, payload: string): boolean {
    if (this.isEcho(managed, payload)) {
      this.warnLoop(managed, connectionId, 'echo')
      return true
    }
    if (this.isLoop(managed, connectionId)) {
      this.warnLoop(managed, connectionId, 'rate')
      return true
    }
    // Traffic that passes the guard clears the warned flag so a later, genuine
    // loop can be reported again.
    managed.loopWarned.delete(connectionId)
    return false
  }

  private emitRoute(connectionId: string): void {
    this.getSender()?.send(IPC.PTY_ROUTE, { connectionId })
  }

  /** Accumulate continuous-mode output; flush on a throttle without dropping. */
  private enqueueContinuous(managed: ManagedPty, rule: RoutingRule, clean: string): void {
    const key = rule.connectionId
    let q = managed.routeQueues.get(key)
    if (!q) {
      q = { buf: '', timer: null }
      managed.routeQueues.set(key, q)
    }
    q.buf += clean
    if (q.buf.length > ROUTE_QUEUE_MAX_BYTES) q.buf = q.buf.slice(q.buf.length - ROUTE_QUEUE_MAX_BYTES)
    if (!q.timer) q.timer = setTimeout(() => this.flushContinuous(managed, rule), CONTINUOUS_THROTTLE_MS)
  }

  private flushContinuous(managed: ManagedPty, rule: RoutingRule): void {
    const key = rule.connectionId
    const q = managed.routeQueues.get(key)
    if (!q) return
    q.timer = null
    const payload = q.buf.slice(0, 4000)
    q.buf = ''
    if (!payload.trim()) return
    if (this.shouldBlockRoute(managed, key, payload)) return
    for (const tid of rule.targetTerminalIds) {
      this.write(tid, payload)
      this.recordInbound(tid, payload)
    }
    this.emitRoute(key)
  }

  private flush(managed: ManagedPty, force = false): void {
    if (managed.flushTimer) {
      clearTimeout(managed.flushTimer)
      managed.flushTimer = null
    }
    if (!managed.pending) return
    if (managed.mode === 'buffer' && !force) return
    const chunk = managed.pending
    managed.pending = ''
    this.getSender()?.send(IPC.PTY_DATA, { id: managed.id, data: chunk })
  }

  setMode(id: string, mode: RenderMode): void {
    const t = this.terminals.get(id)
    if (!t) return
    t.mode = mode
    // Becoming active: flush anything pending immediately for snappy focus.
    if (mode === 'active') this.flush(t, true)
  }

  write(id: string, data: string): void {
    const t = this.terminals.get(id)
    if (t && !t.exited) {
      t.proc.write(data)
      t.awaitingSignalled = false // user responded — clear the confirmation-prompt badge
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terminals.get(id)
    if (t && !t.exited && cols > 0 && rows > 0) {
      try {
        t.proc.resize(cols, rows)
        this.startStartupCommand(t)
      } catch {
        /* pty may have exited between checks */
      }
    }
  }

  private startStartupCommand(t: ManagedPty): void {
    if (!t.startupPending || t.exited || !t.input.startupCommand) return
    t.startupPending = false
    if (t.startupTimer) {
      clearTimeout(t.startupTimer)
      t.startupTimer = null
    }
    t.proc.write(t.input.startupCommand + '\r')
  }

  getBuffer(id: string): string {
    const t = this.terminals.get(id)
    if (!t) return ''
    t.errorSignalled = false // reading buffer clears the error badge
    return t.buffer.join('')
  }

  getBufferInfo(id: string): { data: string; total: number } {
    const t = this.terminals.get(id)
    if (!t) return { data: '', total: 0 }
    t.errorSignalled = false
    return { data: t.buffer.join(''), total: t.totalEmitted }
  }

  restart(id: string): { pid: number } | null {
    const t = this.terminals.get(id)
    if (!t) return null
    const input = t.input
    this.kill(id)
    return this.create(id, input)
  }

  kill(id: string): void {
    const t = this.terminals.get(id)
    if (!t) return
    if (t.flushTimer) clearTimeout(t.flushTimer)
    if (t.startupTimer) clearTimeout(t.startupTimer)
    for (const q of t.routeQueues.values()) if (q.timer) clearTimeout(q.timer)
    try {
      if (!t.exited) t.proc.kill()
    } catch {
      /* already dead */
    }
    this.terminals.delete(id)
  }

  killAll(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id)
  }

  pids(): { id: string; pid: number }[] {
    return [...this.terminals.values()]
      .filter((t) => !t.exited && t.proc.pid > 0)
      .map((t) => ({ id: t.id, pid: t.proc.pid }))
  }

  setScrollback(lines: number): void {
    this.maxLines = lines
  }

  setPassiveInterval(ms: number): void {
    this.passiveIntervalMs = ms
  }

  // ---- Routing ----
  private static MAX_ROUTE_PATTERN_LEN = 500 // basic ReDoS guard

  setRouting(id: string, rules: RoutingRule[]): void {
    const t = this.terminals.get(id)
    if (!t) return
    if (!rules.length) {
      t.routingRules = undefined
      t.compiledRules = undefined
      return
    }
    t.routingRules = rules
    // Compile each trigger pattern ONCE here instead of on every onData chunk.
    // Invalid or over-long patterns get a null `re` and are skipped at runtime.
    t.compiledRules = rules.map((rule) => {
      if (rule.routeBehavior === 'continuous') return { rule, re: null }
      if (rule.triggerPattern.length > PtyManager.MAX_ROUTE_PATTERN_LEN) {
        console.warn(
          `[PtyManager] routing pattern too long (${rule.triggerPattern.length} > ${PtyManager.MAX_ROUTE_PATTERN_LEN}); skipping rule for connection ${rule.connectionId}.`
        )
        return { rule, re: null }
      }
      try {
        return { rule, re: new RegExp(rule.triggerPattern, 'gs') }
      } catch {
        return { rule, re: null }
      }
    })
  }

  // ---- Recording ----
  startRecording(id: string): void {
    const t = this.terminals.get(id)
    if (t && !t.recording) {
      t.recording = true
      t.recordingStart = Date.now()
      t.recordedChunks = []
      t.recordedBytes = 0
    }
  }

  stopRecording(id: string): RecordingEntry[] {
    const t = this.terminals.get(id)
    if (!t) return []
    t.recording = false
    return [...t.recordedChunks]
  }

  getRecording(id: string): RecordingEntry[] {
    const t = this.terminals.get(id)
    return t ? [...t.recordedChunks] : []
  }
}
