import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  Server,
  isSerialConnection,
  protocolLabel,
  DEFAULT_TERMINAL_SETTINGS,
  normalizeTerminalSettings,
  type FileFontStyle,
} from '@shared/types'
import { applyResolvedTheme, normalizeThemePreference, resolveTheme } from '../../lib/theme'
import XTerm, { XTermHandle } from './XTerm'
import TerminalActionsMenu, { TerminalMenuAnchor } from './TerminalActionsMenu'

interface TerminalPopoutAppProps {
  serverId: string
  sessionId: string
}

const TerminalPopoutApp: React.FC<TerminalPopoutAppProps> = ({ serverId, sessionId }) => {
  const [server, setServer] = useState<Server | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  const [terminalMenu, setTerminalMenu] = useState<TerminalMenuAnchor | null>(null)
  const [fontStyle, setFontStyle] = useState<FileFontStyle>(DEFAULT_TERMINAL_SETTINGS.fontStyle)
  const [fontSize, setFontSize] = useState(DEFAULT_TERMINAL_SETTINGS.fontSize)
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: 'success' | 'error' | 'info' }>>([])
  const xtermRef = useRef<XTermHandle | null>(null)
  const toastIdRef = useRef(0)

  const closeTerminalMenu = useCallback(() => setTerminalMenu(null), [])

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = ++toastIdRef.current
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3200)
  }, [])

  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      try {
        const settings = await window.electronAPI?.getSettings?.()
        if (settings) {
          const preference = normalizeThemePreference(settings.theme)
          const resolved = await resolveTheme(preference)
          if (!cancelled) applyResolvedTheme(resolved)
          const terminal = normalizeTerminalSettings(settings.terminal)
          if (!cancelled) {
            setFontStyle(terminal.fontStyle)
            setFontSize(terminal.fontSize)
          }
        }
        const servers = await window.electronAPI?.getServers?.()
        const match = servers?.find(s => s.id === serverId) ?? null
        if (cancelled) return
        if (!match) {
          setError('Server not found')
          return
        }
        setServer(match)
        document.title = isSerialConnection(match)
          ? `Serial — ${match.name}`
          : `${protocolLabel(match.protocol)} — ${match.name}`
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [serverId])

  useEffect(() => {
    if (!window.electronAPI?.onSystemThemeChange) return
    return window.electronAPI.onSystemThemeChange(resolved => {
      applyResolvedTheme(resolved)
    })
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onTerminalScrollbackRequest) return
    return window.electronAPI.onTerminalScrollbackRequest(requestId => {
      const scrollback = xtermRef.current?.serialize() ?? ''
      void window.electronAPI.respondTerminalScrollback(requestId, scrollback)
    })
  }, [])

  if (error) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface text-sm text-muted-foreground">
        {error}
      </div>
    )
  }

  if (!server) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface text-sm text-muted-foreground">
        Loading terminal…
      </div>
    )
  }

  const headerPadStyle: React.CSSProperties = { paddingLeft: 16, paddingRight: 148 }

  return (
    <div className="h-screen w-screen flex flex-col bg-surface overflow-hidden">
      <div
        className="h-12 border-b border-border flex items-center gap-3 bg-surface-elevated shrink-0"
        style={{ WebkitAppRegion: 'drag', ...headerPadStyle } as React.CSSProperties}
      >
        <img
          src="./logo-icon.png"
          alt="PuppyFTP"
          title="Terminal actions"
          className="h-6 w-6 object-contain shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onContextMenu={e => {
            e.preventDefault()
            e.stopPropagation()
            setTerminalMenu({ x: e.clientX, y: e.clientY })
          }}
          draggable={false}
        />
        <span
          className="font-mono text-xs bg-muted px-2 py-0.5 rounded"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {isSerialConnection(server) ? 'Serial' : protocolLabel(server.protocol)}
        </span>
        <span className="font-medium truncate">{server.name}</span>
        <span className="text-muted-foreground text-xs truncate">
          {isSerialConnection(server)
            ? `— ${server.serialPort || 'COM?'}${server.baudRate ? ` @ ${server.baudRate}` : ''}`
            : `— ${server.username}@${server.host}:${server.port}`}
        </span>
      </div>

      {terminalMenu && (
        <TerminalActionsMenu
          open
          anchor={terminalMenu}
          terminal={xtermRef.current}
          onClose={closeTerminalMenu}
          onNotify={message => showToast(message, 'success')}
        />
      )}

      <div className="flex-1 min-h-0 overflow-hidden relative">
        {closed ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground bg-[#0a0a0f]">
            Session ended
          </div>
        ) : (
          <XTerm
            ref={xtermRef}
            server={server}
            existingSessionId={sessionId}
            detachOnUnmount
            active
            fontStyle={fontStyle}
            fontSize={fontSize}
            onDisconnected={() => setClosed(true)}
            onConnectFailed={() => setError('Could not attach to terminal session')}
          />
        )}
      </div>

      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`px-4 py-2 rounded-md shadow-lg text-sm font-medium text-white ${t.type === 'error' ? 'bg-red-600' : t.type === 'success' ? 'bg-emerald-600' : 'bg-zinc-800 border border-border'}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}

export default TerminalPopoutApp
