import type { ITheme } from '@xterm/xterm'

export interface TerminalThemeDef {
  name: string
  theme: ITheme
}

export const TERMINAL_THEMES: TerminalThemeDef[] = [
  {
    name: 'Zeonica',
    theme: {
      background: '#01001D', foreground: '#FFFFFF', cursor: '#FFFFFF', cursorAccent: '#01001D',
      selectionBackground: '#242272', black: '#0C0C0C', red: '#CC2929', green: '#21C221',
      yellow: '#D6C315', blue: '#3E31F5', magenta: '#D918B9', cyan: '#13D4D4', white: '#B2B2B2',
      brightBlack: '#686868', brightRed: '#FF6E6E', brightGreen: '#6BFF6B',
      brightYellow: '#FFFF6B', brightBlue: '#737CFF', brightMagenta: '#FF70FF',
      brightCyan: '#7FFFFF', brightWhite: '#FFFFFF'
    }
  },
  {
    name: 'TermFlow Dark',
    theme: {
      background: '#141820',
      foreground: '#e8eaf0',
      cursor: '#f5e642',
      cursorAccent: '#141820',
      selectionBackground: 'rgba(47,128,255,0.35)',
      black: '#141820',
      red: '#ff4d4f',
      green: '#3fb950',
      yellow: '#f6c343',
      blue: '#2f80ff',
      magenta: '#b48ead',
      cyan: '#3fb950',
      white: '#e8eaf0',
      brightBlack: '#6f7685',
      brightRed: '#ff6b6b',
      brightGreen: '#6dd98a',
      brightYellow: '#f9d26b',
      brightBlue: '#5c9fff',
      brightMagenta: '#d0a3d8',
      brightCyan: '#6dd98a',
      brightWhite: '#ffffff'
    }
  },
  {
    name: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: 'rgba(189,147,249,0.35)',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92d0',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  {
    name: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#839496',
      cursorAccent: '#002b36',
      selectionBackground: 'rgba(38,139,210,0.35)',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  },
  {
    name: 'One Dark',
    theme: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selectionBackground: 'rgba(97,175,239,0.35)',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  },
  {
    name: 'VS Code Light',
    theme: {
      background: '#ffffff',
      foreground: '#1e1e1e',
      cursor: '#000000',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(0,122,204,0.35)',
      black: '#000000',
      red: '#cd3131',
      green: '#00bc00',
      yellow: '#949800',
      blue: '#0451a5',
      magenta: '#bc05bc',
      cyan: '#0598bc',
      white: '#555555',
      brightBlack: '#666666',
      brightRed: '#cd3131',
      brightGreen: '#14ce14',
      brightYellow: '#b5ba00',
      brightBlue: '#0451a5',
      brightMagenta: '#bc05bc',
      brightCyan: '#0598bc',
      brightWhite: '#a5a5a5'
    }
  }
]

export function getTheme(name: string): TerminalThemeDef {
  return TERMINAL_THEMES.find((t) => t.name === name) || TERMINAL_THEMES[0]
}
