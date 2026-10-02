import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled offline UI and mono fonts — no CDN dependency for a local app.
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import { App } from './App.tsx'
import { ToastHost } from './components/common/Toast.tsx'
import { ErrorBoundary } from './components/common/ErrorBoundary.tsx'
import { TooltipProvider } from './components/ui/TooltipProvider.tsx'
import { registerServiceWorker } from './pwa/register-service-worker.ts'
import { migrateLegacyStorage } from './lib/legacy-storage.ts'
import './styles/app.css'
import './styles/markdown.css'
import './styles/motion.css'

// Pre-rename `mini-dsh.*` browser state moves to `dnt-harness.*` before first read.
try { migrateLegacyStorage(window.localStorage) } catch { /* storage may be unavailable */ }

registerServiceWorker()

createRoot(document.getElementById('root') ?? document.body).render(
  <StrictMode>
    <TooltipProvider>
      <ToastHost>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </ToastHost>
    </TooltipProvider>
  </StrictMode>,
)
