import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { registerWriter } from '../terminalRegistry'
import { useAppStore } from '../store/appStore'

interface Props {
  terminalId: string
  active: boolean
}

const THEME = {
  background: '#141820',
  foreground: '#e8eaf0',
  cursor: '#f5e642',
  cursorAccent: '#141820',
  selectionBackground: 'rgba(47,128,255,0.35)',
  black: '#141820',
  brightBlack: '#6f7685'
}

/**
 * A single xterm.js instance bound to a PTY. Handles input forwarding (only
 * while active — PRD FR-012), buffer rehydration on mount with live chunks
 * queued to avoid ordering races, WebGL rendering when enabled, and debounced
 * fit/resize -> node-pty resize. Render mode is pushed to main so passive
 * terminals stream at a throttled cadence. (PRD §10.4, §11, §12)
 */
export default function TerminalView({ terminalId, active }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)
  const useWebgl = useAppStore((s) => s.settings.webgl)
  const scrollback = useAppStore((s) => s.settings.scrollback)

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback,
      theme: THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    let webgl: WebglAddon | null = null
    if (useWebgl) {
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl?.dispose()
          webgl = null
        })
        term.loadAddon(webgl)
      } catch {
        webgl = null // fall back to DOM renderer
      }
    }
    termRef.current = term
    fitRef.current = fit

    try {
      fit.fit()
    } catch {
      /* not visible yet */
    }

    // Rehydrate from the main-process ring buffer, queueing any live chunks that
    // arrive before the buffer is applied so output never interleaves. (Bug #3)
    let disposed = false
    let ready = false
    const queue: string[] = []
    const unregister = registerWriter(terminalId, (data) => {
      if (ready) term.write(data)
      else queue.push(data)
    })
    window.termflow.pty.buffer(terminalId).then((buf) => {
      if (disposed) return
      if (buf) term.write(buf)
      for (const q of queue) term.write(q)
      queue.length = 0
      ready = true
    })

    // Forward input to the PTY only when this terminal is the active one.
    const dataSub = term.onData((data) => {
      if (activeRef.current) window.termflow.pty.write(terminalId, data)
    })

    // Tell main this terminal is now visible (passive by default; active flip
    // happens in the separate effect below).
    window.termflow.pty.setMode(terminalId, active ? 'active' : 'passive')

    // Debounced resize -> compute cols/rows -> resize PTY. (PRD §11.7)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const doFit = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposed) return
        try {
          fit.fit()
          window.termflow.pty.resize(terminalId, term.cols, term.rows)
        } catch {
          /* ignore */
        }
      }, 60)
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(host)

    return () => {
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      ro.disconnect()
      dataSub.dispose()
      unregister()
      // Component unmounts when the node is minimized -> switch main to
      // buffer-only mode so the process keeps running without streaming.
      window.termflow.pty.setMode(terminalId, 'buffer')
      // Dispose the WebGL addon before the terminal core to avoid a render
      // frame touching a disposed core (the "_isDisposed" TypeError).
      try {
        webgl?.dispose()
      } catch {
        /* ignore */
      }
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId])

  // React to active changes: focus, refit, and update the render mode.
  useEffect(() => {
    window.termflow.pty.setMode(terminalId, active ? 'active' : 'passive')
    if (active && termRef.current) {
      termRef.current.focus()
      try {
        fitRef.current?.fit()
        window.termflow.pty.resize(terminalId, termRef.current.cols, termRef.current.rows)
      } catch {
        /* ignore */
      }
    }
  }, [active, terminalId])

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
