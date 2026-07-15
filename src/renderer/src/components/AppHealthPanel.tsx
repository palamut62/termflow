import { useEffect, useMemo } from 'react'
import { CheckCircle2, TriangleAlert, XCircle, Wrench, RefreshCw } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { getLeafTerminalIds } from '../paneUtils'

type Severity = 'ok' | 'warn' | 'error'

interface HealthIssue {
  id: string
  severity: Severity
  label: string
  detail: string
  fixLabel?: string
  fix?: () => void
}

// Flag a terminal as "heavy" above this resident memory (bytes). pidusage
// reports RSS; AI CLIs legitimately run large, so the bar is deliberately high.
const HEAVY_MEM = 1_500_000_000

/**
 * Self-diagnosing panel for TermFlow's own runtime health — detects orphaned
 * sessions, dead/errored terminals, broken agent links and runaway processes,
 * and offers one-click fixes. Distinct from Workspace Health (which checks the
 * project: path/git/node/npm). Rendered as the top section of Developer Center.
 */
export default function AppHealthPanel(): React.JSX.Element {
  const nodes = useAppStore((s) => s.nodes)
  const terminals = useAppStore((s) => s.terminals)
  const connections = useAppStore((s) => s.connections)
  const procStats = useAppStore((s) => s.procStats)
  const clearAllDetached = useAppStore((s) => s.clearAllDetached)
  const restartNode = useAppStore((s) => s.restartNode)
  const removeConnection = useAppStore((s) => s.removeConnection)
  const refreshStats = useAppStore((s) => s.refreshStats)

  // Refresh CPU/RAM once when the panel mounts so the runaway check is current.
  useEffect(() => { void refreshStats() }, [refreshStats])

  const issues = useMemo<HealthIssue[]>(() => {
    const attached = new Set(
      nodes.flatMap((n) => (n.panes ? getLeafTerminalIds(n.panes) : n.terminalId ? [n.terminalId] : []))
    )
    const nodeIds = new Set(nodes.map((n) => n.id))
    const out: HealthIssue[] = []

    // 1) Orphaned / detached sessions no longer on the canvas.
    const detached = Object.values(terminals).filter((t) => !attached.has(t.id))
    if (detached.length) {
      out.push({
        id: 'orphans',
        severity: 'warn',
        label: `${detached.length} detached session${detached.length !== 1 ? 's' : ''}`,
        detail: 'Card-less sessions lingering in the store.',
        fixLabel: 'Clear all',
        fix: () => void clearAllDetached()
      })
    }

    // 2) Errored terminals still on the canvas.
    const errored = nodes.filter((n) => n.status === 'error')
    if (errored.length) {
      out.push({
        id: 'errored',
        severity: 'error',
        label: `${errored.length} terminal${errored.length !== 1 ? 's' : ''} in error state`,
        detail: 'Process failed to start or crashed.',
        fixLabel: 'Restart all',
        fix: () => errored.forEach((n) => void restartNode(n.id))
      })
    }

    // 3) Stopped terminals still on the canvas (process ended, card kept).
    const stopped = nodes.filter((n) => n.status === 'stopped')
    if (stopped.length) {
      out.push({
        id: 'stopped',
        severity: 'warn',
        label: `${stopped.length} stopped terminal${stopped.length !== 1 ? 's' : ''}`,
        detail: 'Process exited but the card is still open.',
        fixLabel: 'Restart all',
        fix: () => stopped.forEach((n) => void restartNode(n.id))
      })
    }

    // 4) Agent connections pointing at nodes that no longer exist.
    const brokenConns = connections.filter((c) => !nodeIds.has(c.sourceNodeId) || !nodeIds.has(c.targetNodeId))
    if (brokenConns.length) {
      out.push({
        id: 'connections',
        severity: 'warn',
        label: `${brokenConns.length} broken agent link${brokenConns.length !== 1 ? 's' : ''}`,
        detail: 'Connections reference a removed terminal.',
        fixLabel: 'Repair',
        fix: () => brokenConns.forEach((c) => removeConnection(c.id))
      })
    }

    // 5) Runaway processes — informational (no destructive auto-fix).
    const heavy = Object.entries(procStats).filter(([, s]) => s && s.memory > HEAVY_MEM)
    if (heavy.length) {
      const worst = Math.max(...heavy.map(([, s]) => s.memory))
      out.push({
        id: 'heavy',
        severity: 'warn',
        label: `${heavy.length} high-memory process${heavy.length !== 1 ? 'es' : ''}`,
        detail: `Peak ~${(worst / 1_073_741_824).toFixed(1)} GB RAM. Review and close if unexpected.`
      })
    }

    return out
  }, [nodes, terminals, connections, procStats, clearAllDetached, restartNode, removeConnection])

  const healthy = issues.length === 0

  return (
    <div className="dev-section">
      <div className="dev-section-title">
        <span>App health</span>
        <button className="hbtn" title="Re-check" aria-label="Re-check app health" onClick={() => void refreshStats()}>
          <RefreshCw size={14} />
        </button>
      </div>

      {healthy ? (
        <div className="health-row ok">
          <CheckCircle2 size={13} />
          <span>All clear</span>
          <em>No runtime issues detected</em>
        </div>
      ) : (
        issues.map((issue) => (
          <div className={`health-row ${issue.severity === 'error' ? 'error' : 'warn'}`} key={issue.id}>
            {issue.severity === 'error' ? <XCircle size={13} /> : <TriangleAlert size={13} />}
            <span>{issue.label}</span>
            <em title={issue.detail}>{issue.detail}</em>
            {issue.fix && (
              <button className="health-fix" title={issue.fixLabel} onClick={issue.fix}>
                <Wrench size={12} /> {issue.fixLabel}
              </button>
            )}
          </div>
        ))
      )}
    </div>
  )
}
