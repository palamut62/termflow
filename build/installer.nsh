; Stop an older TermFlow instance (including its detached PTY daemon) before
; replacing files. Without this, NSIS pauses with "TermFlow cannot be closed"
; when a user starts an update while the app is still running in the tray.
!macro customInit
  nsExec::ExecToLog 'taskkill /F /T /IM TermFlow.exe'
!macroend
