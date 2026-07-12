import { useEffect, useRef, useState } from 'react'
import { Terminal, type IDecoration } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { registerWriter } from '../terminalRegistry'
import { useAppStore } from '../store/appStore'
import { captureCommandInput } from '../commandHistory'
import { getTheme } from '../themes'

interface Props {
  terminalId: string
  active: boolean
}

/**
 * Scan the terminal buffer for lines matching any active highlight rule and
 * register decorations on them. All previous decorations are disposed first so
 * the view stays in sync with the current rule set. (P1-8)
 */
function applyHighlights(
  term: Terminal,
  rules: { pattern: string; flags: string; color: string }[],
  decorsRef: { current: IDecoration[] }
): void {
  for (const d of decorsRef.current) {
    try { d.dispose() } catch { /* already disposed */ }
  }
  decorsRef.current = []
  if (!rules.length) return

  const buffer = term.buffer.active
  const startRow = Math.max(0, buffer.length - 500)
  for (let row = startRow; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line) continue
    const text = line.translateToString()
    for (const rule of rules) {
      try {
        const re = new RegExp(rule.pattern, rule.flags)
        if (re.test(text)) {
          // Marker offset: 0 = cursor line, negative values go back in history
          const marker = term.registerMarker(-(buffer.length - 1 - row))
          const deco = term.registerDecoration({
            marker,
            backgroundColor: rule.color,
            width: term.cols
          })
          if (deco) decorsRef.current.push(deco)
          break // only the first matching rule per line
        }
      } catch {
        // invalid regex in the rule — skip silently
      }
    }
  }
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
  const nudgeRef = useRef<(() => void) | null>(null)
  const activeRef = useRef(active)
  const useWebgl = useAppStore((s) => s.settings.webgl)
  const scrollback = useAppStore((s) => s.settings.scrollback)
  const fontFamily = useAppStore((s) => s.settings.fontFamily)
  const fontSize = useAppStore((s) => s.settings.fontSize)
  const lineHeight = useAppStore((s) => s.settings.lineHeight)
  const cursorStyle = useAppStore((s) => s.settings.cursorStyle)
  const cursorBlink = useAppStore((s) => s.settings.cursorBlink)
  const terminalThemeName = useAppStore((s) => s.settings.terminalTheme)
  const appTheme = useAppStore((s) => s.settings.theme)
  const transparency = useAppStore((s) => s.settings.transparency)
  const highlightRules = useAppStore((s) => s.highlightRules)
  const terminalCount = useAppStore((s) => Object.keys(s.terminals).length)

  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchRegex, setSearchRegex] = useState(false)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const existingDecorsRef = useRef<IDecoration[]>([])
  const lastTotalRef = useRef(0)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleHighlights = (term: Terminal): void => {
    if (highlightTimerRef.current) return
    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = null
      const rules = useAppStore.getState().highlightRules
      if (rules.length) applyHighlights(term, rules, existingDecorsRef)
    }, 500)
  }

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily,
      fontSize,
      lineHeight,
      cursorBlink,
      cursorStyle,
      scrollback,
      theme: getTheme(terminalThemeName).theme,
      allowProposedApi: true,
      // ConPTY re-renders the viewport itself on resize; without this flag
      // xterm ALSO reflows its buffer and the two rewraps mangle TUI output.
      windowsPty: { backend: 'conpty' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    searchAddonRef.current = searchAddon
    term.open(host)
    // WebGL off for now — causes orange-block corruption on resize (GPU texture
    // atlas invalidation on some Windows drivers). DOM renderer is stable.
    // Re-enable by restoring `useWebgl &&` once the atlas bug is resolved.
    const WEBGL_DISABLED = true
    let webgl: WebglAddon | null = null
    if (!WEBGL_DISABLED && useWebgl) {
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          addon.dispose()
          webgl = null
        })
        term.loadAddon(addon)
        webgl = addon
      } catch {
        webgl = null // fall back to DOM renderer
      }
    }
    termRef.current = term
    fitRef.current = fit

    try {
      fit.fit()
      // Sync the PTY to the real cell size immediately — the PTY spawns at a
      // 120x30 default, and TUI apps that draw their first frames at that
      // width leave permanently-wrapped garbage in the ring buffer otherwise.
      window.termflow.pty.resize(terminalId, term.cols, term.rows)
    } catch {
      /* not visible yet */
    }

    // Ask the running TUI to repaint at the current size: ConPTY only emits a
    // resize to the child when dimensions actually change, so bounce one column
    // and restore it. Used after buffer replays, which may contain frames drawn
    // at older sizes (the source of the "broken shapes until focused" artifact).
    // Force ConPTY to emit a SIGWINCH by bouncing rows instead of columns.
    // Column bounce causes the child to redraw at cols-1 width; that output
    // wraps incorrectly when written to xterm at full width (broken layouts).
    // Row bounce keeps the same wrapping width — far less visual disruption.
    const nudgeRepaint = (): void => {
      if (disposed || term.rows < 3) return
      window.termflow.pty.resize(terminalId, term.cols, term.rows - 1)
      setTimeout(() => {
        if (!disposed) window.termflow.pty.resize(terminalId, term.cols, term.rows)
      }, 50)
    }

    // Rehydrate from the main-process ring buffer, queueing any live chunks that
    // arrive before the buffer is applied so output never interleaves. (Bug #3)
    let disposed = false
    let ready = false
    const queue: string[] = []
    const unregister = registerWriter(terminalId, (data) => {
      if (ready) {
        term.write(data, () => {
          lastTotalRef.current += data.length
          scheduleHighlights(term)
        })
      } else {
        queue.push(data)
      }
    })
    window.termflow.pty.bufferInfo(terminalId).then(({ data, total }) => {
      if (disposed) return
      if (data) term.write(data)
      lastTotalRef.current = total
      for (const q of queue) {
        lastTotalRef.current += q.length
        term.write(q)
      }
      queue.length = 0
      ready = true
      scheduleHighlights(term)
    })
    nudgeRef.current = nudgeRepaint

    // Forward input to the PTY only when this terminal is the active one.
    const dataSub = term.onData((data) => {
      if (!activeRef.current) return
      const state = useAppStore.getState()
      if (state.activeWorkspaceId) captureCommandInput(state.activeWorkspaceId, terminalId, state.terminals[terminalId]?.cwd ?? '', data)
      window.termflow.pty.write(terminalId, data)
      // Broadcast keystrokes to all members of the broadcast group (P0-4)
      const st = useAppStore.getState()
      if (st.broadcastEnabled && st.broadcastGroup.includes(terminalId)) {
        for (const tid of st.broadcastGroup) {
          if (tid !== terminalId) window.termflow.pty.write(tid, data)
        }
      }
    })
    // Ctrl+F toggles the inline search bar overlay.
    const keySub = term.onKey(({ domEvent }) => {
      if (domEvent.ctrlKey && domEvent.key === 'f') {
        domEvent.preventDefault()
        setSearchVisible((v) => !v)
      }
    })

    // Tell main this terminal is now visible (passive by default; active flip
    // happens in the separate effect below).
    window.termflow.pty.setMode(terminalId, active ? 'active' : (terminalCount > 6 ? 'buffer' : 'passive'))

    // Debounced resize. The xterm canvas refits quickly (visual smoothness),
    // but the PTY resize waits for the drag to END: every ConPTY resize
    // rewraps its buffer lossily, so a stream of intermediate resizes
    // compounds into mangled TUI output (broken banners/borders in claude &
    // co). One final resize = one rewrap. No extra nudge here — the resize
    // itself already makes live TUIs redraw. (PRD §11.7)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let ptyResizeTimer: ReturnType<typeof setTimeout> | null = null
    let prevCols = term.cols
    let prevRows = term.rows
    const doFit = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposed) return
        try {
          fit.fit()
        } catch {
          /* ignore */
        }
      }, 60)
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      ptyResizeTimer = setTimeout(() => {
        if (disposed) return
        try {
          fit.fit()
          if (term.cols !== prevCols || term.rows !== prevRows) {
            window.termflow.pty.resize(terminalId, term.cols, term.rows)
            prevCols = term.cols
            prevRows = term.rows
          }
        } catch {
          /* ignore */
        }
      }, 300)
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(host)

    return () => {
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      if (ptyResizeTimer) clearTimeout(ptyResizeTimer)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      ro.disconnect()
      dataSub.dispose()
      keySub.dispose()
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
      nudgeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId])

  // React to active changes: focus, refit, and update the render mode.
  useEffect(() => {
    const mode = active ? 'active' : (terminalCount > 6 ? 'buffer' : 'passive')
    window.termflow.pty.setMode(terminalId, mode)
    if (active && termRef.current) {
      termRef.current.focus()
      try {
        fitRef.current?.fit()
        window.termflow.pty.resize(terminalId, termRef.current.cols, termRef.current.rows)
      } catch {
        /* ignore */
      }
      // Nudge forces ConPTY to emit SIGWINCH so the TUI redraws at the
      // current terminal size. No buffer replay — ring buffer data may
      // still be at old dimensions; replaying it would place ANSI-
      // positioned content at wrong coordinates (the remaining corruption).
      nudgeRef.current?.()
    }
  }, [active, terminalId, terminalCount])

  // Keep xterm options in sync with settings changes (font, theme, cursor, etc.).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const s = useAppStore.getState().settings
    term.options.fontFamily = s.fontFamily
    term.options.fontSize = s.fontSize
    term.options.lineHeight = s.lineHeight
    term.options.cursorStyle = s.cursorStyle
    term.options.cursorBlink = s.cursorBlink
    const base = getTheme(s.terminalTheme).theme
    const css = getComputedStyle(document.documentElement)
    term.options.theme = {
      ...base,
      background: transparency < 100 ? 'rgba(0,0,0,0)' : css.getPropertyValue('--bg-terminal').trim(),
      cursor: css.getPropertyValue('--active-border').trim(),
      selectionBackground: css.getPropertyValue('--accent-soft').trim()
    }
  }, [fontFamily, fontSize, lineHeight, cursorStyle, cursorBlink, terminalThemeName, appTheme, transparency])

  // Re-apply highlight decorations when the rule set changes.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    applyHighlights(term, highlightRules, existingDecorsRef)
  }, [highlightRules])

  // Focus search input when the bar opens.
  useEffect(() => {
    if (searchVisible && searchInputRef.current) searchInputRef.current.focus()
  }, [searchVisible])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }} className="nodrag nowheel">
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      {searchVisible && (
        <div
          style={{
            position: 'absolute' as const,
            top: 4,
            right: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: '#1e2530',
            border: '1px solid #3a4050',
            borderRadius: 6,
            padding: '4px 8px',
            zIndex: 10
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearchVisible(false)
              termRef.current?.focus()
            }
            e.stopPropagation()
          }}
        >
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                searchAddonRef.current?.findNext(searchQuery, {
                  caseSensitive: searchCaseSensitive,
                  regex: searchRegex,
                  decorations: {
                    matchBackground: '#2f80ff44',
                    matchOverviewRuler: '#2f80ff',
                    activeMatchBackground: '#2f80ff88',
                    activeMatchColorOverviewRuler: '#2f80ff'
                  }
                })
              }
            }}
            placeholder="Find..."
            style={{
              background: '#0d1117',
              border: '1px solid #3a4050',
              borderRadius: 4,
              color: '#e8eaf0',
              padding: '2px 6px',
              width: 160,
              outline: 'none'
            }}
          />
          <button
            onClick={() =>
              searchAddonRef.current?.findPrevious(searchQuery, {
                caseSensitive: searchCaseSensitive,
                regex: searchRegex,
                decorations: {
                  matchBackground: '#2f80ff44',
                  matchOverviewRuler: '#2f80ff',
                  activeMatchBackground: '#2f80ff88',
                  activeMatchColorOverviewRuler: '#2f80ff'
                }
              })
            }
            style={{ background: 'transparent', border: 'none', color: '#a0a7b4', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontSize: 12, lineHeight: 1 }}
            title="Previous match"
          >
            &#9650;
          </button>
          <button
            onClick={() =>
              searchAddonRef.current?.findNext(searchQuery, {
                caseSensitive: searchCaseSensitive,
                regex: searchRegex,
                decorations: {
                  matchBackground: '#2f80ff44',
                  matchOverviewRuler: '#2f80ff',
                  activeMatchBackground: '#2f80ff88',
                  activeMatchColorOverviewRuler: '#2f80ff'
                }
              })
            }
            style={{ background: 'transparent', border: 'none', color: '#a0a7b4', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontSize: 12, lineHeight: 1 }}
            title="Next match"
          >
            &#9660;
          </button>
          <button
            onClick={() => setSearchCaseSensitive((v) => !v)}
            style={{
              background: searchCaseSensitive ? '#2f80ff44' : 'transparent',
              border: 'none',
              color: '#a0a7b4',
              cursor: 'pointer',
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1
            }}
            title="Case sensitive"
          >
            Aa
          </button>
          <button
            onClick={() => setSearchRegex((v) => !v)}
            style={{
              background: searchRegex ? '#2f80ff44' : 'transparent',
              border: 'none',
              color: '#a0a7b4',
              cursor: 'pointer',
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1
            }}
            title="Regex"
          >
            .*
          </button>
          <button
            onClick={() => {
              setSearchVisible(false)
              termRef.current?.focus()
            }}
            style={{ background: 'transparent', border: 'none', color: '#a0a7b4', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontSize: 12, lineHeight: 1 }}
            title="Close"
          >
            X
          </button>
        </div>
      )}
    </div>
  )
}
