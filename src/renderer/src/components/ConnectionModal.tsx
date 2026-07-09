import { useState } from 'react'
import type { ConnectionType } from '../../../shared/types'

export interface ConnectionFormResult {
  type: ConnectionType
  label?: string
  routeBehavior?: 'marker' | 'continuous' | 'disabled'
  routeDirection?: 'source_to_target' | 'bidirectional'
  triggerPattern?: string
  transform?: string
}

interface Props {
  onSubmit: (result: ConnectionFormResult) => void
  onClose: () => void
}

const TYPES: { value: ConnectionType; label: string }[] = [
  { value: 'control', label: 'Control Flow' },
  { value: 'data', label: 'Data Flow' },
  { value: 'log', label: 'Log Flow' },
  { value: 'error', label: 'Error Flow' },
  { value: 'dependency', label: 'Dependency' },
  { value: 'parent_child', label: 'Parent / Child' },
  { value: 'trigger', label: 'Trigger' },
  { value: 'manual', label: 'Manual Link' }
]

export default function ConnectionModal({ onSubmit, onClose }: Props): React.JSX.Element {
  const [type, setType] = useState<ConnectionType>('control')
  const [label, setLabel] = useState('')
  const [routeBehavior, setRouteBehavior] = useState<'marker' | 'continuous' | 'disabled'>('disabled')
  const [routeDirection, setRouteDirection] = useState<'source_to_target' | 'bidirectional'>('source_to_target')
  const [triggerPattern, setTriggerPattern] = useState('@@HANDOFF@@([\\s\\S]*?)@@END@@')
  const [transform, setTransform] = useState('')

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} style={{ maxHeight: '85vh', overflow: 'auto' }}>
        <h3>Create Connection</h3>
        <div className="field">
          <label>Connection type</label>
          <select value={type} onChange={(e) => setType(e.target.value as ConnectionType)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Label (optional)</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. TASK_READY" autoFocus />
        </div>

        <div className="field">
          <label>Route Behavior (Agent-to-Agent)</label>
          <select
            value={routeBehavior}
            onChange={(e) => {
              const next = e.target.value as 'marker' | 'continuous' | 'disabled'
              setRouteBehavior(next)
              if (next !== 'marker') setRouteDirection('source_to_target')
            }}
          >
            <option value="disabled">Disabled</option>
            <option value="marker">Marker-based (@@HANDOFF@@)</option>
            <option value="continuous">Continuous (all output)</option>
          </select>
        </div>

        {routeBehavior !== 'disabled' && (
          <div className="field">
            <label>Route Direction</label>
            <select
              value={routeDirection}
              onChange={(e) => setRouteDirection(e.target.value as 'source_to_target' | 'bidirectional')}
            >
              <option value="source_to_target">Source output to target input</option>
              {routeBehavior === 'marker' && (
                <option value="bidirectional">Both terminals send marker output to each other</option>
              )}
            </select>
            {routeBehavior === 'continuous' && (
              <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                Continuous routing is one-way to avoid echo loops between terminals.
              </p>
            )}
          </div>
        )}

        {routeBehavior === 'marker' && (
          <>
            <div className="field">
              <label>Trigger Pattern (regex)</label>
              <input value={triggerPattern}
                onChange={(e) => setTriggerPattern(e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }} />
              <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                Match groups captured and available for transform ($1, $2, ...)
              </p>
            </div>
            <div className="field">
              <label>Output Transform (optional)</label>
              <input value={transform}
                onChange={(e) => setTransform(e.target.value)}
                placeholder="e.g. echo $1"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }} />
              <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                Use $1, $2 for capture groups. Leave empty to forward raw match.
              </p>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSubmit({
            type, label: label || undefined,
            routeBehavior,
            routeDirection: routeBehavior === 'disabled' ? undefined : routeDirection,
            triggerPattern: routeBehavior === 'marker' ? triggerPattern : undefined,
            transform: routeBehavior === 'marker' ? transform || undefined : undefined
          })}>Connect</button>
        </div>
      </div>
    </div>
  )
}
