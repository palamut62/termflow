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
  startupTimer: NodeJS.Timeout | null
  startupPending: boolean
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

    if (managed.mode === 'buffer') return // no streaming while offscreen/minimized

    managed.pending += data
    if (!managed.flushTimer) {
      const interval = managed.mode === 'active' ? ACTIVE_INTERVAL_MS : this.passiveIntervalMs
      managed.flushTimer = setTimeout(() => this.flush(managed), interval)
    }
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
