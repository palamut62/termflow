// Single source of truth for the About section. APP_VERSION is injected from
// package.json at build time, so it always reflects the shipped release. Add a
// new CHANGELOG entry (newest first) whenever the version is bumped.

export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'

export interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.3.3',
    date: '2026-07-22',
    changes: [
      'Agent roles now come with real per-role system prompts, sent automatically once an agent node\'s CLI is ready; user-editable in Settings.',
      'Applying a flow template asks for the team\'s task/goal and kicks off the first agent automatically instead of leaving the pipeline idle.',
      'Agent Teams: shared task store with a simple coordinator (round-robin assignment, retry-on-failure, per-team concurrency limit) and team-level start/pause/stop controls.',
      'Per-agent permission policy with a session-only bypass toggle — bypass grants never persist across restarts.',
      'Desktop notifications for long-running commands, errors and agents waiting on input.',
      'Workspace templates: save a workspace as a reusable template and spin up new workspaces (or clones) from it.',
      'package.json script runner integrated into the terminal launcher.',
      'Global search across terminals, snippets and workspaces.',
      'Deeper Git integration: ahead/behind status, workbench improvements.',
      'Security and typecheck fixes across the agent-team and routing code.'
    ]
  },
  {
    version: '0.1.0',
    date: '2026-07-15',
    changes: [
      'Per-terminal agent panel: a collapsible right panel on each terminal showing its sub-agents, tasks and tools; click an agent to follow its flow.',
      'Broader agent detection: terminals launched with a known AI CLI (Claude Code, Codex, Gemini, Aider, Ollama and more) are recognised automatically.',
      'Detached sessions redesigned as a bottom dock with per-session terminate, a Clear all action, and automatic cleanup of orphaned sessions on load.',
      'App Health: a self-diagnosing panel that detects errored/stopped terminals, broken agent links and runaway processes with one-click fixes.',
      'Developer Center now opens as a right dock that shrinks the canvas instead of covering terminals.',
      'Plugin development platform, adaptive tiled layout, broadcast input, session recording, AI log summaries and deep Git integration.'
    ]
  }
]

export interface DeveloperInfo {
  name: string
  role: string
  bio: string
  links: { label: string; url: string }[]
}

export const DEVELOPER: DeveloperInfo = {
  name: 'Umut Çelik',
  role: 'Creator & Developer',
  bio: 'TermFlow is designed and built by Umut Çelik — a Windows multi-terminal and multi-agent canvas workspace for developers who run many shells and AI coding agents side by side.',
  links: [
    { label: 'GitHub', url: 'https://github.com/palamut62' },
    { label: 'Repository', url: 'https://github.com/palamut62/termflow' },
    { label: 'X (Twitter)', url: 'https://x.com/palamut62' },
    { label: 'Email', url: 'mailto:umutins62@hotmail.com' }
  ]
}
