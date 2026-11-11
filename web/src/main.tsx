import { createRoot } from 'react-dom/client'
import '@fontsource/barlow-condensed/latin-500.css'
import '@fontsource/barlow-condensed/latin-600.css'
import '@fontsource/barlow-condensed/latin-700.css'
import '@fontsource/source-serif-4/latin-400.css'
import '@fontsource/source-serif-4/latin-400-italic.css'
import '@fontsource/source-serif-4/latin-600.css'
import { bootDemo } from './demo/install'
import { Board } from './board/Board'
import './board/tokens.css'
import './board/parts.css'
import './board/zones.css'

// `?demo=1`, the preview build, or no answer from /api/overview within 3 s: run on the in-browser simulator instead of the backend.
bootDemo()
createRoot(document.getElementById('root')!).render(<Board />)
