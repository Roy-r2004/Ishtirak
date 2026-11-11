import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import { bootDemo } from './demo/install'
import { Board } from './board/Board'
import { readTheme, themeAttribute } from './board/console-logic'
import './board/tokens.css'
import './board/console.css'

// A stored theme choice is applied before the first paint so the page never flashes the wrong palette.
try { const attr = themeAttribute(readTheme(localStorage)); if (attr) document.documentElement.dataset.theme = attr } catch { /* blocked storage: follow the system */ }
// `?demo=1`, the preview build, or no answer from /api/overview within 3 s: run on the in-browser simulator instead of the backend.
bootDemo()
createRoot(document.getElementById('root')!).render(<Board />)
