import { Bot, FolderOpen, Grid2X2, HeartPulse, Keyboard, Radio, Search, Settings, TerminalSquare, X, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useModalClose } from '../hooks/useModalClose'

interface HelpTopic {
  id: string
  category: string
  title: string
  summary: string
  steps: string[]
  notes?: string[]
}

const topics: HelpTopic[] = [
  { id: 'workspace', category: 'Getting started', title: 'Create and open a workspace', summary: 'A workspace keeps terminals, layouts, connections, snippets, providers, and developer settings together.', steps: ['Choose New Workspace in the sidebar.', 'Select the project folder and enter a workspace name.', 'Reopen the workspace from the sidebar whenever you return.'], notes: ['Workspace data is saved automatically.', 'Deleting a workspace removes its TermFlow layout, not the project folder on disk.'] },
  { id: 'terminal', category: 'Terminals', title: 'Open a terminal', summary: 'Run CMD, PowerShell, PowerShell Core, WSL, Git Bash, SSH, or a custom command in a real PTY.', steps: ['Open the New Terminal menu.', 'Choose a shell type.', 'Click the terminal before typing so it becomes the active input target.'], notes: ['A green status means the PTY is running.', 'Restart or close controls are available from the terminal header.'] },
  { id: 'folder', category: 'Terminals', title: 'Open a terminal at any folder', summary: 'Start the selected shell with a working directory different from the workspace root.', steps: ['Open New Terminal > Open terminal at folder.', 'Choose CMD, PowerShell, WSL, or Git Bash.', 'Browse to a folder or enter its full path.', 'Choose Open terminal.'] },
  { id: 'layout', category: 'Layout', title: 'Adaptive tiled layout', summary: 'Terminals fill the fixed workspace without gaps and resize together.', steps: ['Click a terminal to focus it.', 'Drag the active terminal’s right divider.', 'Move right to enlarge it or left to give more room to the other terminals.', 'Release the mouse; the selected ratio is retained.'], notes: ['Clicking empty canvas space only clears selection; it does not reset sizes.', 'Adding a terminal recalculates the tiled layout so every panel fits.'] },
  { id: 'manual', category: 'Layout', title: 'Manual and agent graph modes', summary: 'Use free positioning when the relationship between terminals matters more than dense tiling.', steps: ['Open Layout in the header.', 'Choose Manual for free movement or Agent Graph for connected agents.', 'Pan and zoom are enabled only in these canvas-oriented modes.'] },
  { id: 'providers', category: 'AI providers', title: 'Configure DeepSeek, Ollama, or another provider', summary: 'Provider profiles connect a terminal command to model and API endpoint environment variables.', steps: ['Right-click empty canvas space.', 'Choose Configure providers.', 'Enter the CLI command, model, base URL, and variable names.', 'Save the profile.', 'Add the API key separately in Settings > Developer > Workspace Environment.', 'Right-click the canvas again and select the provider to launch it.'], notes: ['API keys are never stored inside provider profiles.', 'DeepSeek and Ollama starter profiles are included and may be edited.'] },
  { id: 'agents', category: 'AI providers', title: 'Launch and observe AI agents', summary: 'Run Claude Code, Codex, OpenCode, Ollama, or provider-backed commands beside normal terminals.', steps: ['Choose New Agent or an AI entry under New Terminal.', 'Select an agent role when role labeling is useful.', 'Open Agent Activity to inspect detected tasks, tools, handoffs, and statuses.'], notes: ['Auto-approve mode grants broad CLI permissions; use it only in trusted folders.'] },
  { id: 'broadcast', category: 'Workflows', title: 'Broadcast keyboard input', summary: 'Send the same keystrokes to multiple terminals at once.', steps: ['Use the radio icon in each terminal header to add it to the broadcast group.', 'Enable Broadcast in the main header.', 'Type in the active terminal.', 'Disable Broadcast before returning to single-terminal input.'], notes: ['Commands are executed independently by every terminal in the group.'] },
  { id: 'recording', category: 'Workflows', title: 'Record and save a terminal session', summary: 'Capture terminal output with timing information and export it as an asciinema-compatible .cast file.', steps: ['Click the record icon in the terminal header.', 'Use the terminal normally while recording is active.', 'Click the record icon again to stop capturing.', 'Choose Save Recording and select a destination for the .cast file.'], notes: ['Recording captures terminal output and timing, not a video file.', 'The .cast format can be replayed with asciinema-compatible tools.', 'Save Recording exports the last captured recording for that terminal.'] },
  { id: 'developer', category: 'Developer tools', title: 'Developer Center', summary: 'Check project health and launch workspace-aware tasks.', steps: ['Choose the activity icon in the header.', 'Refresh Workspace Health to check path, Git, Node, npm, and manifest status.', 'Run project tasks declared by .termflow.json.', 'Use Export Diagnostics for a sanitized support report.'] },
  { id: 'workbench', category: 'Developer tools', title: 'Developer Workbench', summary: 'Browse project files, preview text, inspect command history, and complete Git operations without leaving TermFlow.', steps: ['Choose the panel icon in the header.', 'Use Files for workspace-scoped browsing and safe text preview.', 'Use Command history to copy previously executed commands.', 'Use Git to review the diff, select paths, stage or unstage, and commit.'] },
  { id: 'agent-ops', category: 'Developer tools', title: 'Agent metrics and credential vault', summary: 'Review agent duration/token/cost data and provide encrypted credentials to PTYs.', steps: ['Choose the gauge icon in the header.', 'Review per-session and aggregate metrics.', 'Add a credential name, provider, environment key, and secret value.', 'Choose workspace scope or make it available globally.', 'New PTYs receive matching credentials as environment variables.'], notes: ['Secret values are encrypted by Windows and never returned to the renderer.'] },
  { id: 'plugins', category: 'Developer tools', title: 'Plugins and workflow packages', summary: 'Install declarative command plugins and move agent-flow templates between TermFlow installations.', steps: ['Choose the puzzle icon in the header.', 'Install a versioned plugin JSON manifest.', 'Review every exposed command before running it.', 'Use Export workflows or Import workflows for flow-template packages.'], notes: ['Plugins cannot inject renderer JavaScript.'] },
  { id: 'tray', category: 'Application', title: 'Windows startup and system tray', summary: 'Keep terminals alive when the main window is closed.', steps: ['Open Settings > General.', 'Enable Start TermFlow with Windows if required.', 'Enable Keep running in the system tray when closed.', 'Close the window to hide it without stopping PTYs.', 'Double-click the tray icon to reopen, or choose Quit TermFlow to exit completely.'] },
  { id: 'updates', category: 'Application', title: 'Stable and beta updates', summary: 'Check GitHub Releases and install a downloaded update after restart.', steps: ['Open Settings > General > Application updates.', 'Choose Stable or Beta.', 'Enable Automatic or use Check now.', 'Wait for the download status to reach Ready.', 'Choose Restart and install update.'] },
  { id: 'recovery', category: 'Troubleshooting', title: 'Recover after a crash', summary: 'TermFlow detects an unclean exit and rebuilds persisted workspace terminals on the next launch.', steps: ['Restart TermFlow after an unexpected exit.', 'Choose Continue restored session to keep recreated terminals.', 'Choose Start clean to terminate restored PTYs and clear the canvas session.'] },
  { id: 'shortcuts', category: 'Reference', title: 'Keyboard shortcuts', summary: 'Reach common actions without leaving the terminal.', steps: ['Ctrl+K — command palette', 'Ctrl+Alt+V — vertical split', 'Ctrl+Alt+H — horizontal split', 'Ctrl+Alt+Enter — focus/restore terminal', 'Ctrl+Alt+Arrow — move focus between terminals'] },
  { id: 'errors', category: 'Troubleshooting', title: 'Terminal shows error or PID 0', summary: 'The requested shell or provider command could not start.', steps: ['Confirm the CLI is installed and available in PATH.', 'Confirm the selected working directory exists.', 'Check provider command and environment variable names.', 'Use Restart after correcting the configuration.', 'Open Developer Center to verify Node, npm, Git, and manifest health.'] }
]

const categoryIcons: Record<string, LucideIcon> = {
  'Getting started': Grid2X2, Terminals: TerminalSquare, Layout: Grid2X2,
  'AI providers': Bot, Workflows: Radio, 'Developer tools': HeartPulse,
  Application: Settings, Reference: Keyboard, Troubleshooting: HeartPulse
}

export default function HelpModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const categories = [...new Set(topics.map((topic) => topic.category))]
  const [category, setCategory] = useState(categories[0])
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(topics[0].id)
  const filtered = useMemo(() => topics.filter((topic) => {
    const matchesQuery = `${topic.title} ${topic.summary} ${topic.steps.join(' ')}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery && (!query || topic.category === category || query.length > 0)
  }), [category, query])
  const visible = query ? filtered : topics.filter((topic) => topic.category === category)
  const active = visible.find((topic) => topic.id === activeId) ?? visible[0]
  useModalClose(onClose)

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal help-center" onMouseDown={(event) => event.stopPropagation()}>
        <header className="help-head"><div><h3>TermFlow Help Center</h3><p>Features, setup guides, workflows, and troubleshooting.</p></div><button className="hbtn" aria-label="Close help" onClick={onClose}><X size={16} /></button></header>
        <div className="help-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search help topics..." /></div>
        <div className="help-layout">
          <nav className="help-categories">
            {categories.map((item) => { const Icon = categoryIcons[item] ?? FolderOpen; return <button className={category === item && !query ? 'active' : ''} key={item} onClick={() => { setQuery(''); setCategory(item); const first = topics.find((topic) => topic.category === item); if (first) setActiveId(first.id) }}><Icon size={14} /><span>{item}</span></button> })}
          </nav>
          <div className="help-topics">
            {visible.length === 0 && <div className="help-empty">No matching help topic.</div>}
            {visible.map((topic) => <button className={active?.id === topic.id ? 'active' : ''} key={topic.id} onClick={() => setActiveId(topic.id)}><strong>{topic.title}</strong><span>{topic.summary}</span></button>)}
          </div>
          <article className="help-article">
            {active && <><span className="help-kicker">{active.category}</span><h2>{active.title}</h2><p>{active.summary}</p><h4>How to use it</h4><ol>{active.steps.map((step) => <li key={step}>{step}</li>)}</ol>{active.notes?.length && <><h4>Important notes</h4><ul>{active.notes.map((note) => <li key={note}>{note}</li>)}</ul></>}</>}
          </article>
        </div>
      </div>
    </div>
  )
}
