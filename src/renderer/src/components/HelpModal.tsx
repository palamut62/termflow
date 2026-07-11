import { Bot, FolderOpen, Grid2X2, HeartPulse, Keyboard, Radio, TerminalSquare } from 'lucide-react'

const topics = [
  { icon: TerminalSquare, title: 'Terminals', text: 'Open CMD, PowerShell, WSL, Git Bash, SSH, or a custom command as a real PTY session.' },
  { icon: Grid2X2, title: 'Adaptive layout', text: 'Click a terminal to focus it. Drag its right divider to redistribute the fixed workspace without losing your ratio.' },
  { icon: FolderOpen, title: 'Open at folder', text: 'Choose a terminal type and any working directory from the New Terminal menu.' },
  { icon: Bot, title: 'AI agents', text: 'Launch Claude Code, Codex, OpenCode, Ollama, or configured provider commands beside normal terminals.' },
  { icon: Radio, title: 'Broadcast', text: 'Send the same keyboard input to every terminal included in the broadcast group.' },
  { icon: HeartPulse, title: 'Developer Center', text: 'Inspect runtimes, Git and project health, run manifest tasks, and export sanitized diagnostics.' },
  { icon: Keyboard, title: 'Shortcuts', text: 'Ctrl+K opens the command palette. Ctrl+Alt+V/H splits the active panel. Ctrl+Alt+Enter toggles focus.' }
]

export default function HelpModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal help-modal" onMouseDown={(event) => event.stopPropagation()}>
        <h3>TermFlow Help</h3>
        <p className="help-intro">A quick guide to the main workspace features.</p>
        <div className="help-grid">
          {topics.map(({ icon: Icon, title, text }) => <section key={title}><Icon size={18} /><div><strong>{title}</strong><p>{text}</p></div></section>)}
        </div>
        <div className="modal-actions"><button className="btn primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}
