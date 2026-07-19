import { memo, useEffect, useMemo, useRef } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot } from 'lucide-react'
import { useAppStore } from '../store/appStore'

// PTY-less canvas node for an agent-team member. Reuses the ReactFlow node
// wrapper/handles so measurement and edge routing behave like TerminalNode, but
// the inner body is a read-only terminal-styled live log instead of an xterm.
function TeamMemberNodeInner({ id }: NodeProps): React.JSX.Element {
  const node = useAppStore((s) => s.nodes.find((n) => n.id === id))
  const bundle = useAppStore((s) => (node?.teamId ? s.teamBundles[node.teamId] : undefined))
  const activeNodeId = useAppStore((s) => s.activeNodeId)
  const logRef = useRef<HTMLPreElement>(null)

  const member = useMemo(
    () => bundle?.members.find((m) => m.id === node?.teamMemberId),
    [bundle, node?.teamMemberId]
  )
  const lines = useMemo(() => {
    if (!bundle || !node?.teamMemberId) return [] as string[]
    return bundle.events
      .filter((e) => e.memberId === node.teamMemberId && ['note', 'member.started', 'task.updated'].includes(e.type))
      .slice(-40)
      .map((e) => e.message)
  }, [bundle, node?.teamMemberId])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])

  if (!node || !member) return <div />

  const active = activeNodeId === id
  const working = member.status === 'working'

  return (
    <div className="tnode-wrap">
      <div className={`tnode team-node ${active ? 'active' : ''} ${working ? 'team-working' : ''}`}>
        <Handle type="target" position={Position.Left} />
        <div className="tnode-header">
          <Bot size={14} color="var(--accent)" />
          <span className="title">{member.name}</span>
          <span className="kind-tag">{member.role} · {member.provider}</span>
          <em className={`team-status ${member.status}`} style={{ marginLeft: 'auto' }}>{member.status}</em>
        </div>
        <div className="tnode-body">
          <pre ref={logRef} className="team-node-log nodrag nowheel">
            {lines.length ? lines.join('\n') : 'Waiting for activity…'}
          </pre>
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
    </div>
  )
}

export default memo(TeamMemberNodeInner)
