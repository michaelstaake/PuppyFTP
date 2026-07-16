import React from 'react'
import { Server, protocolLabel } from '@shared/types'
import { MessageCircle, RefreshCw, TreePine, Unplug, WifiOff, Loader2 } from 'lucide-react'
import XTerm from '../terminal/XTerm'
import DualPaneExplorer, { DualPaneExplorerHandle } from '../explorer/DualPaneExplorer'

interface MainAreaProps {
  server: Server | null
  connectedServers: Server[]
  isConnected: boolean
  isConnecting: boolean
  isConnectionLost: boolean
  isConnectionFailed: boolean
  sessionGenerationByServerId: Record<string, number>
  onConnect: () => void
  onDisconnect: () => void
  onReconnect: () => void
  aiEnabled: boolean
  aiChatOpen?: boolean
  onToggleAIChat: () => void
  onSessionConnected: (serverId: string) => void
  onSessionFailed: (serverId: string) => void
  onSessionClosed: (serverId: string) => void
}

const MainArea: React.FC<MainAreaProps> = ({
  server,
  connectedServers,
  isConnected,
  isConnecting,
  isConnectionLost,
  isConnectionFailed,
  sessionGenerationByServerId,
  onConnect,
  onDisconnect,
  onReconnect,
  aiEnabled,
  aiChatOpen = false,
  onToggleAIChat,
  onSessionConnected,
  onSessionFailed,
  onSessionClosed,
}) => {
  const explorerRef = React.useRef<DualPaneExplorerHandle>(null)
  const [explorerStatus, setExplorerStatus] = React.useState({ loading: false, isExploring: false })
  const [appVersion, setAppVersion] = React.useState<string | null>(null)

  const handleExplorerStatus = React.useCallback((status: { loading: boolean; isExploring: boolean }) => {
    setExplorerStatus(status)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const loadVersion = async () => {
      if (!window.electronAPI?.getAppInfo) return
      try {
        const info = await window.electronAPI.getAppInfo()
        if (!cancelled) setAppVersion(info.version)
      } catch {
        // leave version unset
      }
    }
    void loadVersion()
    return () => {
      cancelled = true
    }
  }, [])

  if (!server) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-surface text-center p-8">
        <img
          src="./logo-icon.png"
          alt="PuppyFTP"
          className="h-20 w-20 object-contain mb-4"
        />
        <h2 className="text-xl font-semibold mb-2">PuppyFTP</h2>
        {appVersion && (
          <p className="text-muted-foreground text-sm">v{appVersion}</p>
        )}
      </div>
    )
  }

  const isFileTransfer =
    server.protocol === 'sftp' ||
    server.protocol === 'ftp' ||
    server.protocol === 'ftps' ||
    server.protocol === 'ftps-implicit'

  const sessionOpen = isConnected || isConnecting || isConnectionLost || isConnectionFailed
  const blockContent = isConnecting || isConnectionLost || isConnectionFailed

  return (
    <div className="flex-1 flex flex-col bg-surface min-h-0">
      <div className="h-12 border-b border-border px-4 flex items-center justify-between bg-surface-elevated shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded">
            {protocolLabel(server.protocol)}
          </span>
          <span className="font-medium">{server.name}</span>
          <span className="text-muted-foreground text-xs">
            — {server.username}@{server.host}:{server.port}
          </span>
        </div>

        <div className="flex items-center gap-1 no-drag">
          {isConnected && isFileTransfer && (
            <>
              <button
                type="button"
                onClick={() => explorerRef.current?.refresh()}
                disabled={explorerStatus.loading}
                title="Refresh"
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${explorerStatus.loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => explorerRef.current?.exploreFullTree()}
                disabled={explorerStatus.isExploring}
                title="Explore full tree"
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
              >
                <TreePine className="h-4 w-4" />
              </button>
            </>
          )}

          {isConnected && (
            <button
              type="button"
              onClick={onDisconnect}
              title="Disconnect"
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <Unplug className="h-4 w-4" />
            </button>
          )}

          {aiEnabled && (
            <button
              type="button"
              onClick={onToggleAIChat}
              title="Ask AI"
              aria-label="Ask AI"
              aria-pressed={aiChatOpen}
              className={`p-1.5 rounded-md ${
                aiChatOpen
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <MessageCircle className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden relative">
        {!sessionOpen && (
          <button
            type="button"
            onClick={onConnect}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors cursor-pointer"
          >
            <Unplug className="h-8 w-8 opacity-50" />
            <div className="text-sm font-medium">Not connected</div>
            <div className="text-xs opacity-80">Click anywhere in this area to connect</div>
          </button>
        )}

        {isConnecting && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-surface text-foreground">
            <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" aria-hidden />
            <div className="text-sm font-medium">Connecting…</div>
          </div>
        )}

        {isConnectionFailed && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-surface text-foreground">
            <WifiOff className="h-8 w-8 text-red-500 opacity-90" aria-hidden />
            <div className="text-center px-6">
              <div className="text-sm font-medium">Unable to connect</div>
              <div className="text-xs text-muted-foreground mt-1">
                Could not reach this server. Check the host, port, and credentials, then try again.
              </div>
            </div>
            <button
              type="button"
              onClick={onReconnect}
              className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Attempt to connect again
            </button>
          </div>
        )}

        {isConnectionLost && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-surface text-foreground">
            <WifiOff className="h-8 w-8 text-red-500 opacity-90" aria-hidden />
            <div className="text-center px-6">
              <div className="text-sm font-medium">Server connection lost</div>
              <div className="text-xs text-muted-foreground mt-1">
                The connection to this server dropped. Close the session or try reconnecting.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onDisconnect}
                className="px-3 py-1.5 text-sm rounded-md border border-border bg-card hover:bg-muted transition-colors"
              >
                Close connection
              </button>
              <button
                type="button"
                onClick={onReconnect}
                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
              >
                Attempt to reconnect
              </button>
            </div>
          </div>
        )}

        {connectedServers.map(s => {
          const isActive = isConnected && s.id === server.id
          const sIsTerminal = s.protocol === 'ssh'
          const sIsFileTransfer =
            s.protocol === 'sftp' ||
            s.protocol === 'ftp' ||
            s.protocol === 'ftps' ||
            s.protocol === 'ftps-implicit'
          const generation = sessionGenerationByServerId[s.id] || 0

          return (
            <div
              key={`${s.id}-${generation}`}
              className={
                sessionOpen && s.id === server.id
                  ? `h-full w-full ${blockContent ? 'invisible pointer-events-none' : ''}`
                  : 'hidden'
              }
              aria-hidden={!isActive}
            >
              {sIsTerminal && (
                <XTerm
                  server={s}
                  active={isActive || (isConnecting && s.id === server.id)}
                  onConnected={() => onSessionConnected(s.id)}
                  onConnectFailed={() => onSessionFailed(s.id)}
                  onDisconnected={() => onSessionClosed(s.id)}
                />
              )}
              {sIsFileTransfer && (
                <DualPaneExplorer
                  ref={isActive ? explorerRef : undefined}
                  server={s}
                  onStatusChange={isActive ? handleExplorerStatus : undefined}
                  onConnected={() => onSessionConnected(s.id)}
                  onConnectFailed={() => onSessionFailed(s.id)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default MainArea
