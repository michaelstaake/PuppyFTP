import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Server, protocolLabel } from '@shared/types'
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
  const xtermRef = useRef<XTermHandle | null>(null)

  const closeTerminalMenu = useCallback(() => setTerminalMenu(null), [])

  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      try {
        const settings = await window.electronAPI?.getSettings?.()
        if (settings) {
          const preference = normalizeThemePreference(settings.theme)
          const resolved = await resolveTheme(preference)
          if (!cancelled) applyResolvedTheme(resolved)
        }
        const servers = await window.electronAPI?.getServers?.()
        const match = servers?.find(s => s.id === serverId) ?? null
        if (cancelled) return
        if (!match) {
          setError('Server not found')
          return
        }
        setServer(match)
        document.title = `SSH — ${match.name}`
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

  const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined
  const headerPadStyle: React.CSSProperties =
    platform === 'darwin'
      ? { paddingLeft: 78, paddingRight: 16 }
      : { paddingLeft: 16, paddingRight: 148 }

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
          {protocolLabel(server.protocol)}
        </span>
        <span className="font-medium truncate">{server.name}</span>
        <span className="text-muted-foreground text-xs truncate">
          — {server.username}@{server.host}:{server.port}
        </span>
      </div>

      {terminalMenu && (
        <TerminalActionsMenu
          open
          anchor={terminalMenu}
          terminal={xtermRef.current}
          onClose={closeTerminalMenu}
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
            onDisconnected={() => setClosed(true)}
            onConnectFailed={() => setError('Could not attach to terminal session')}
          />
        )}
      </div>
    </div>
  )
}

export default TerminalPopoutApp
