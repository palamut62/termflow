import { memo, useMemo } from 'react'
import { type NodeProps } from '@xyflow/react'
import { Bot, CheckCircle2, Clock3, Radio } from 'lucide-react'
import { useAppStore } from '../store/appStore'

// PTY-less canvas node for an agent-team member. Reuses the ReactFlow node
// wrapper/handles so measurement and edge routing behave like TerminalNode, but
// the inner body is a read-only terminal-styled live log instead of an xterm.
function TeamMemberNodeInner({ id }: NodeProps): React.JSX.Element {
  const node = useAppStore((s) => s.nodes.find((n) => n.id === id))
  const bundle = useAppStore((s) => (node?.teamId ? s.teamBundles[node.teamId] : undefined))
  const activeNodeId = useAppStore((s) => s.activeNodeId)
  const member = useMemo(
    () => bundle?.members.find((m) => m.id === node?.teamMemberId),
    [bundle, node?.teamMemberId]
  )
  if (!node || !member) return <div />

  const active = activeNodeId === id
  const working = member.status === 'working'
  const memberTasks = bundle?.tasks.filter((task) => task.assigneeId === member.id) ?? []
  const currentTask = memberTasks.find((task) => !['completed', 'cancelled'].includes(task.status)) ?? memberTasks.at(-1)
  const executionOrder = [...new Set(bundle?.tasks.map((task) => task.assigneeId).filter(Boolean) ?? [])]
  const stage = Math.max(1, executionOrder.indexOf(member.id) + 1)
  const lastEvent = bundle?.events.filter((event) => event.memberId === member.id).at(-1)
  const completedTasks = memberTasks.filter((task) => task.status === 'completed').length
  const progress = Math.round((completedTasks / Math.max(1, memberTasks.length)) * 100)
  const tool = member.executionProfileId?.split(':')[1] ?? member.provider

  return (
    <div className="tnode-wrap">
      <div className={`tnode team-node ${active ? 'active' : ''} ${working ? 'team-working' : ''}`}>
        <div className="tnode-header">
          <Bot size={14} color="var(--accent)" />
          <span className="title">{member.name}</span>
          <em className={`team-status ${member.status}`}>{working && <Radio size={10} />} {working ? 'ACTIVE' : member.status}</em>
        </div>
        <div className="team-stage-meta"><span>Stage {stage}</span><span>{member.role} · {tool}</span></div>
        <div className="team-stage-task">
          {currentTask?.status === 'completed' ? <CheckCircle2 size={15} /> : <Clock3 size={15} />}
          <div><strong>{currentTask?.title ?? 'No assigned task'}</strong><span>{currentTask ? currentTask.status : 'idle'}</span></div>
        </div>
        <div className="team-stage-progress"><span style={{ width: `${progress}%` }} /><em>{progress}%</em></div>
        <p className="team-stage-activity">{lastEvent?.message ?? (working ? 'Working on the assigned stage…' : 'Ready when the previous stage completes.')}</p>
      </div>
    </div>
  )
}

export default memo(TeamMemberNodeInner)
