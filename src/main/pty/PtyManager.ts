import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import type { CreateTerminalInput, RenderMode } from '../../shared/types'
import { IPC } from '../../shared/types'
import { resolveShell } from './shells'

const ACTIVE_INTERVAL_MS = 16 // PRD §11.6 IPC batching for the focused terminal
const DEFAULT_SCROLLBACK_LINES = 10000 // PRD §10.9.1

// Error/activity detection patterns (PRD §10.9.5)
const ERROR_RE = /\b(error|exception|failed|fatal|traceback|npm ERR|ModuleNotFound|SyntaxError|TypeError|Permission denied)\b/i

interface ManagedPty {
  id: string
  proc: pty.IPty
  input: CreateTerminalInput
  buffer: string[]
  bufferLines: number
  pending: string
  flushTimer: NodeJS.Timeout | null
  exited: boolean
  exitCode?: number
  mode: RenderMode
  errorSignalled: boolean
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
      pending: '',
      flushTimer: null,
      exited: false,
      mode: 'active',
      errorSignalled: false
    }
    this.terminals.set(id, managed)

    proc.onData((data) => this.onData(managed, data))
    proc.onExit(({ exitCode }) => {
      managed.exited = true
      managed.exitCode = exitCode
      this.flush(managed, true)
      this.getSender()?.send(IPC.PTY_EXIT, { id, exitCode })
    })

    // Type the startup command into the interactive shell (agents/services).
    if (input.startupCommand && input.kind !== 'custom') {
      setTimeout(() => {
        if (!managed.exited) proc.write(input.startupCommand + '\r')
      }, 350)
    }

    return { pid: proc.pid }
  }

  private countNewlines(s: string): number {
    let n = 0
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
    return n
  }

  private onData(managed: ManagedPty, data: string): void {
    // Ring buffer (single-pass newline count, also cap chunk count). PRD §11.8
    managed.buffer.push(data)
    managed.bufferLines += this.countNewlines(data)
    while (managed.buffer.length > 1 && (managed.bufferLines > this.maxLines || managed.buffer.length > this.maxLines)) {
      const removed = managed.buffer.shift()!
      managed.bufferLines -= this.countNewlines(removed)
    }

    // Error/activity detection — signal once until cleared. PRD §10.9.5
    if (!managed.errorSignalled && ERROR_RE.test(data)) {
      managed.errorSignalled = true
      this.getSender()?.send(IPC.PTY_ACTIVITY, { id: managed.id, error: true })
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
    if (t && !t.exited) t.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terminals.get(id)
    if (t && !t.exited && cols > 0 && rows > 0) {
      try {
        t.proc.resize(cols, rows)
      } catch {
        /* pty may have exited between checks */
      }
    }
  }

  getBuffer(id: string): string {
    const t = this.terminals.get(id)
    if (!t) return ''
    t.errorSignalled = false // reading buffer clears the error badge
    return t.buffer.join('')
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
    return [...this.terminals.values()].filter((t) => !t.exited).map((t) => ({ id: t.id, pid: t.proc.pid }))
  }

  setScrollback(lines: number): void {
    this.maxLines = lines
  }

  setPassiveInterval(ms: number): void {
    this.passiveIntervalMs = ms
  }
}
