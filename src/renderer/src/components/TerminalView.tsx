import { useEffect, useRef, useState } from 'react'
import { Terminal, type IDecoration } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { registerWriter } from '../terminalRegistry'
import { useAppStore } from '../store/appStore'
import { captureCommandInput } from '../commandHistory'
import { getTheme } from '../themes'
import { getLeafTerminalIds } from '../paneUtils'

// Short two-tone chime for the terminal bell (\x07). Web Audio, no asset —
// throttled so a burst of BELs doesn't stack into noise.
let lastBellAt = 0
function playBell(): void {
  const now = Date.now()
  if (now - lastBellAt < 400) return
  lastBellAt = now
  try {
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.12, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28)
    gain.connect(ctx.destination)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.setValueAtTime(1174, ctx.currentTime + 0.12)
    osc.connect(gain)
    osc.start()
    osc.stop(ctx.currentTime + 0.3)
    osc.onended = () => void ctx.close()
  } catch { /* audio unavailable */ }
}

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
  const activeRef = useRef(active)
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

  const [searchVisible, setSearchVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchRegex, setSearchRegex] = useState(false)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const existingDecorsRef = useRef<IDecoration[]>([])
  const lastTotalRef = useRef(0)
  const lastPtySizeRef = useRef({ cols: 0, rows: 0 })
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Single resize channel, populated by the main effect. Other effects call
  // through this ref so every resize goes through the same atomic path.
  const scheduleResizeRef = useRef<(() => void) | null>(null)

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
      // Draw box-drawing / block / Powerline glyphs procedurally instead of
      // using the font's own (often misaligned) glyphs. This is xterm 6's
      // default; stated explicitly so TUI borders stay crisp and gap-free.
      customGlyphs: true,
      // VS Code parity: tell xterm the real ConPTY build so its reflow
      // behaviour matches what the backend actually does. On modern builds
      // (>= 21376) ConPTY forwards wrapped-line state and xterm's reflow is
      // correct; lying about the build (or omitting it) causes the mangled /
      // clipped TUI output seen with claude & co.
      windowsPty: { backend: 'conpty', buildNumber: window.termflow.system.osBuildNumber }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    searchAddonRef.current = searchAddon
    term.open(host)
    // Keep the DOM renderer for resize correctness. The WebGL add-on leaves
    // stale atlas tiles/canvas geometry on some Windows GPUs after narrow/wide
    // layout changes, corrupting full-screen TUI borders and glyphs.
    termRef.current = term
    fitRef.current = fit

    try {
      // First measurement: move xterm AND the PTY to the real cell size in the
      // same tick (no settle wait). The PTY spawns at a 120x30 default, and TUI
      // apps that draw their first frames at that width leave permanently-
      // wrapped garbage in the ring buffer otherwise.
      const dims = fit.proposeDimensions()
      if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
        const cols = Math.max(2, Math.floor(dims.cols))
        const rows = Math.max(1, Math.floor(dims.rows))
        term.resize(cols, rows)
        window.termflow.pty.resize(terminalId, cols, rows)
        lastPtySizeRef.current = { cols, rows }
      }
    } catch {
      /* not visible yet */
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
    // Terminal bell: claude/codex ring \x07 when a task finishes — play the
    // chime if enabled in Settings. (user request)
    const bellSub = term.onBell(() => {
      if (useAppStore.getState().settings.terminalBell) playBell()
    })
    // Ctrl+F toggles the inline search bar overlay.
    const keySub = term.onKey(({ domEvent }) => {
      if (domEvent.ctrlKey && domEvent.key === 'f') {
        domEvent.preventDefault()
        setSearchVisible((v) => !v)
      }
    })

    // Every visible terminal stays live. Selection controls keyboard input only;
    // it must not throttle or pause output from background terminals.
    window.termflow.pty.setMode(terminalId, 'active')

    // Single atomic resize channel. Every resize source (observer, activation,
    // font/theme) funnels through here. We wait for the size to settle, then
    // move the xterm view AND the PTY to the new size in the SAME tick —
    // intermediate sizes are never applied. This closes the window where xterm
    // refits instantly while the PTY lags behind, which drew TUI frames at the
    // wrong width. Every ConPTY resize also rewraps its buffer lossily, so one
    // settled resize = one rewrap (no mangled banners/borders in claude & co).
    // (PRD §11.7)
    let resizeSettleTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleTerminalResize = (): void => {
      if (resizeSettleTimer) clearTimeout(resizeSettleTimer)
      resizeSettleTimer = setTimeout(() => {
        if (disposed) return
        const dims = fit.proposeDimensions()
        if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
        const cols = Math.max(2, Math.floor(dims.cols))
        const rows = Math.max(1, Math.floor(dims.rows))
        if (cols === term.cols && rows === term.rows) return
        term.resize(cols, rows) // xterm view
        window.termflow.pty.resize(terminalId, cols, rows) // PTY, same tick
        lastPtySizeRef.current = { cols, rows }
      }, 250)
    }
    scheduleResizeRef.current = scheduleTerminalResize
    // The container's canvas already fills its box via CSS, so no early fit is
    // needed for visual smoothness — an early fit only reintroduces the
    // mismatch window this channel exists to eliminate.
    const ro = new ResizeObserver(() => scheduleTerminalResize())
    ro.observe(host)

    return () => {
      disposed = true
      if (resizeSettleTimer) clearTimeout(resizeSettleTimer)
      scheduleResizeRef.current = null
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      ro.disconnect()
      dataSub.dispose()
      keySub.dispose()
      bellSub.dispose()
      unregister()
      // Component unmounts when the node is minimized -> switch main to
      // buffer-only mode so the process keeps running without streaming.
      window.termflow.pty.setMode(terminalId, 'buffer')
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId])

  // Selection controls editing/focus only. All visible terminals remain live.
  useEffect(() => {
    if (active && termRef.current) {
      termRef.current.focus()
      // Route through the single resize channel — it no-ops if the size hasn't
      // changed and applies xterm + PTY atomically otherwise.
      scheduleResizeRef.current?.()
    }
  }, [active, terminalId])

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
    // A font/size change alters the cell metrics, so the fit result may change;
    // route it through the single atomic resize channel.
    scheduleResizeRef.current?.()
    term.refresh(0, term.rows - 1)
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

  // Clicking INSIDE the terminal must activate its node — xterm swallows the
  // event before React Flow's node-click fires, so a passive terminal would
  // otherwise never accept keystrokes until its header was clicked.
  const activateOnClick = (): void => {
    const st = useAppStore.getState()
    const node = st.nodes.find(
      (n) => n.terminalId === terminalId || (n.panes ? getLeafTerminalIds(n.panes).includes(terminalId) : false)
    )
    if (!node) return
    if (st.activeNodeId !== node.id) st.setActiveNode(node.id)
    if (node.panes && node.activePaneId !== terminalId) st.setActivePane(node.id, terminalId)
  }

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      className="nodrag nowheel"
      onMouseDownCapture={activateOnClick}
    >
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
