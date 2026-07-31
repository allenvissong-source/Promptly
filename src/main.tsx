import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

// --- Viewport size sync (fix: WKWebView lags on 100vh under Tauri Overlay
//     titlebar, causing the layout to compute one stale frame ~48px too tall,
//     pushing the top toolbar out of the visible area). Instead of trusting the
//     browser's 100vh, we write the *real* innerHeight/innerWidth into CSS vars
//     and force a synchronous reflow whenever the viewport changes. ---
function syncViewportVars() {
  const el = document.documentElement
  el.style.setProperty('--app-h', `${window.innerHeight}px`)
  el.style.setProperty('--app-w', `${window.innerWidth}px`)
}
syncViewportVars()
window.addEventListener('resize', syncViewportVars)
window.addEventListener('orientationchange', syncViewportVars)
window.addEventListener('focus', syncViewportVars)
window.addEventListener('pageshow', syncViewportVars)
// DPR changes (dragging between Retina and 1x external displays) don't fire
// 'resize' reliably in WKWebView — re-arm a matchMedia listener each time.
;(function armDprListener() {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  const onChange = () => {
    syncViewportVars()
    armDprListener()
  }
  mq.addEventListener('change', onChange, { once: true })
})()

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
