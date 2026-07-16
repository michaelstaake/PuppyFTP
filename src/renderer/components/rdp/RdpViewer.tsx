import React, { useEffect, useRef, useState } from 'react'
import { Monitor, ExternalLink } from 'lucide-react'
import type { Server } from '@shared/types'

export interface RdpViewerProps {
  server: Server
  /** When true, focus/restore the Remote Desktop window. */
  active: boolean
  onConnected: () => void
  onConnectFailed: (error?: string) => void
  onDisconnected: () => void
}

function readBounds(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const rect = el.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

const RdpViewer: React.FC<RdpViewerProps> = ({
  server,
  active,
  onConnected,
  onConnectFailed,
  onDisconnected,
}) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host || !window.electronAPI?.createRdpSession) {
      onConnectFailed('RDP is not available in this build')
      return
    }

    const start = async () => {
      setStatusError(null)
      try {
        const bounds = readBounds(host)
        const result = await window.electronAPI.createRdpSession(server, bounds)
        if (cancelled) {
          // Do not tear down on Strict Mode remount — App disconnect owns lifecycle.
          return
        }
        if (!result.success || !result.sessionId) {
          const message = result.error || 'Could not start Remote Desktop'
          setStatusError(message)
          onConnectFailed(message)
          return
        }
        sessionIdRef.current = result.sessionId
        setConnected(true)
        onConnected()
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        console.error('[RdpViewer] connect failed', e)
        if (!cancelled) {
          setStatusError(message)
          onConnectFailed(message)
        }
      }
    }

    void start()

    return () => {
      cancelled = true
    }
    // Remount on server id / generation via parent key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id])

  useEffect(() => {
    const id = sessionIdRef.current
    if (!id || !active || !window.electronAPI?.setRdpVisible) return
    void window.electronAPI.setRdpVisible(id, true)
  }, [active])

  // Watch for the user closing mstsc externally.
  useEffect(() => {
    if (!connected || !sessionIdRef.current) return
    const id = sessionIdRef.current
    const timer = window.setInterval(() => {
      void window.electronAPI?.rdpSessionAlive?.(id).then(alive => {
        if (alive === false) {
          sessionIdRef.current = null
          setConnected(false)
          onDisconnected()
        }
      })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [connected, onDisconnected])

  const focusRemote = () => {
    const id = sessionIdRef.current
    if (!id) return
    void window.electronAPI?.setRdpVisible?.(id, true)
  }

  return (
    <div
      ref={hostRef}
      className="h-full w-full bg-surface flex flex-col items-center justify-center gap-3 p-8 text-center"
      aria-label={`RDP session ${server.name}`}
    >
      {statusError ? (
        <>
          <Monitor className="h-10 w-10 text-red-500 opacity-80" aria-hidden />
          <div className="text-sm font-medium text-foreground">Remote Desktop failed</div>
          <div className="text-xs text-muted-foreground max-w-md whitespace-pre-wrap">{statusError}</div>
        </>
      ) : (
        <>
          <Monitor className="h-10 w-10 text-muted-foreground opacity-70" aria-hidden />
          <div className="text-sm font-medium text-foreground">
            {connected ? 'Remote Desktop is open in another window' : 'Starting Remote Desktop…'}
          </div>
          <div className="text-xs text-muted-foreground max-w-md">
            Windows Remote Desktop (`mstsc`) runs in its own window. Use Disconnect in the toolbar
            above to close the session.
          </div>
          {connected && (
            <button
              type="button"
              onClick={focusRemote}
              className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-border bg-card hover:bg-muted transition-colors"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Focus Remote Desktop window
            </button>
          )}
        </>
      )}
    </div>
  )
}

export default RdpViewer
