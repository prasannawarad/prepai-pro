import React from 'react'
import ReactDOM from 'react-dom/client'
import PrepAIPro from './App'
import './index.css'

// Last line of defense: an unexpected render error shows a recoverable page
// instead of a blank white screen. Nothing here depends on app state.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('Unhandled render error:', error, info)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 16,
        padding: 24, textAlign: 'center',
        fontFamily: 'var(--sans, system-ui)', color: 'var(--ink, #EEEBE6)',
      }}>
        <div style={{
          fontFamily: 'var(--mono, monospace)', fontSize: 10,
          letterSpacing: '0.22em', textTransform: 'uppercase',
          color: 'var(--vermillion, #E8553A)',
        }}>
          ⚠ Something broke
        </div>
        <h1 style={{ fontFamily: 'var(--serif, serif)', fontSize: 28, fontWeight: 600 }}>
          The page hit an unexpected error.
        </h1>
        <p style={{ fontSize: 14, color: 'var(--ink-3, #A9A197)', maxWidth: 420, lineHeight: 1.6 }}>
          Reloading usually fixes it. Your inputs live only in this tab, so a
          reload starts fresh.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            fontFamily: 'var(--mono, monospace)', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.14em', textTransform: 'uppercase',
            padding: '12px 24px', cursor: 'pointer',
            background: 'var(--ink, #EEEBE6)', color: 'var(--paper, #1A1714)',
            border: 'none',
          }}
        >
          Reload page
        </button>
      </div>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PrepAIPro />
    </ErrorBoundary>
  </React.StrictMode>,
)
