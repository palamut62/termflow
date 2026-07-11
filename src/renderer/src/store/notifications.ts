import type { AppSettings, CanvasNode } from '../../../shared/types'
import { getLeafTerminalIds } from '../paneUtils'

// Desktop notifications for long-running commands, error output, and agents
// waiting on a confirmation prompt (feature: masaüstü bildirimleri). Fires
// even while the window is minimized/hidden to the tray — the native
// Notification API keeps working in a backgrounded renderer, and clicking a
// notification asks main to restore/focus the window before selecting the
// originating node.

interface NotifyStore {
  getState: () => {
    settings: AppSettings
    nodes: CanvasNode[]
    setActiveNode: (nodeId: string | null) => void
  }
}

let store: NotifyStore | null = null
let permissionRequested = false

export function registerNotificationStore(s: NotifyStore): void {
  store = s
}

function ensurePermission(): void {
  if (permissionRequested) return
  permissionRequested = true
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {
      /* ignored — user declined or platform unsupported */
    })
  }
}

function findNodeForTerminal(nodes: CanvasNode[], terminalId: string): CanvasNode | undefined {
  return nodes.find((n) => n.terminalId === terminalId || (n.panes ? getLeafTerminalIds(n.panes).includes(terminalId) : false))
}

function fire(title: string, body: string, terminalId: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  let n: Notification
  try {
    n = new Notification(title, { body, silent: false })
  } catch {
    return // some platforms throw if notifications are unsupported/disabled
  }
  n.onclick = () => {
    window.termflow.window.focus()
    window.focus()
    const st = store?.getState()
    const node = st ? findNodeForTerminal(st.nodes, terminalId) : undefined
    if (node) st!.setActiveNode(node.id)
    n.close()
  }
}

export function initNotifications(): void {
  ensurePermission()
}

export function notifyLongCommandDone(terminalId: string, terminalName: string, exitCode: number, durationMs: number): void {
  const s = store?.getState().settings
  if (!s?.notificationsEnabled || !s.notifyOnLongCommand) return
  if (durationMs < s.longCommandThresholdMs) return
  ensurePermission()
  const seconds = Math.round(durationMs / 1000)
  fire(`${terminalName} finished`, `Exit code ${exitCode} · took ${seconds}s`, terminalId)
}

export function notifyError(terminalId: string, terminalName: string): void {
  const s = store?.getState().settings
  if (!s?.notificationsEnabled || !s.notifyOnError) return
  ensurePermission()
  fire(`${terminalName}: error detected`, 'An error pattern was detected in the terminal output.', terminalId)
}

export function notifyAgentWaiting(terminalId: string, terminalName: string): void {
  const s = store?.getState().settings
  if (!s?.notificationsEnabled || !s.notifyOnAgentWaiting) return
  ensurePermission()
  fire(`${terminalName}: waiting for confirmation`, 'The agent may have paused on a confirmation or command prompt.', terminalId)
}
