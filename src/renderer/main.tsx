import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import TerminalPopoutApp from './components/terminal/TerminalPopoutApp'
import './styles/globals.css'

const params = new URLSearchParams(window.location.search)
const isPopout = params.get('popout') === '1'
const popoutSessionId = params.get('sessionId')
const popoutServerId = params.get('serverId')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isPopout && popoutSessionId && popoutServerId ? (
      <TerminalPopoutApp serverId={popoutServerId} sessionId={popoutSessionId} />
    ) : (
      <App />
    )}
  </React.StrictMode>
)
