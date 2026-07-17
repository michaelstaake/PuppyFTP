import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Server, DEFAULT_FILES_SETTINGS } from '@shared/types'
import type { FileEntry, FileFontStyle } from '@shared/types'
import { ArrowUp, Folder, File as FileIcon, Loader2 } from 'lucide-react'
import { useExplorerStore } from '../../store/explorerStore'

interface SshSftpSidebarProps {
  server: Server
  open: boolean
  onClose: () => void
  fontStyle?: FileFontStyle
  fontSize?: number
}

function entryTypeLabel(entry: FileEntry): string {
  if (entry.type === 'dir') return 'Folder'
  const idx = entry.name.lastIndexOf('.')
  if (idx <= 0 || idx === entry.name.length - 1) return 'File'
  return entry.name.slice(idx + 1).toUpperCase()
}

function formatMtime(mtime: number): string {
  if (!mtime) return ''
  try {
    return new Date(mtime).toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function entryTooltip(entry: FileEntry): string {
  const modified = formatMtime(entry.mtime)
  return [
    entry.name,
    `Last modified: ${modified || '—'}`,
    `Permissions: ${entry.permissions || '—'}`,
  ].join('\n')
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function parentRemote(remotePath: string): string {
  const parts = remotePath.split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  const up = parts.slice(0, -1).join('/')
  return up ? `/${up}` : '/'
}

function normalizeRemotePath(p: string): string {
  if (!p) return '/'
  const withSlash = p.startsWith('/') ? p : `/${p}`
  if (withSlash.length > 1 && withSlash.endsWith('/')) return withSlash.slice(0, -1)
  return withSlash
}

/**
 * Remote-only SFTP browser for SSH sessions — matches DualPaneExplorer remote pane styling.
 */
const SshSftpSidebar: React.FC<SshSftpSidebarProps> = ({
  server,
  open,
  onClose,
  fontStyle = DEFAULT_FILES_SETTINGS.fontStyle,
  fontSize = DEFAULT_FILES_SETTINGS.fontSize,
}) => {
  const stored = useExplorerStore.getState().getPaths(server.id)
  const setStoredRemote = useExplorerStore(s => s.setRemotePath)

  const [remotePath, setRemotePath] = useState(stored.remotePath)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pathRef = useRef(remotePath)
  pathRef.current = remotePath

  const fileFontClass =
    fontStyle === 'mono' ? 'font-mono' : fontStyle === 'sans' ? 'font-sans' : 'font-ubuntu'
  const fileFontStyle = { fontSize: `${fontSize}px`, lineHeight: 1.45 } as const

  const refresh = useCallback(
    async (p = pathRef.current) => {
      setLoading(true)
      setError(null)
      try {
        const list = await window.electronAPI.listRemote(server.id, p)
        if (list == null) {
          setError('Could not open SFTP session')
          setEntries([])
          return false
        }
        setEntries(sortEntries(list))
        return true
      } catch (e) {
        console.warn(e)
        setError('Could not list remote directory')
        setEntries([])
        return false
      } finally {
        setLoading(false)
      }
    },
    [server.id]
  )

  const goRemote = useCallback(
    async (newPath: string) => {
      const normalized = normalizeRemotePath(newPath)
      setRemotePath(normalized)
      setStoredRemote(server.id, normalized)
      await refresh(normalized)
    },
    [refresh, server.id, setStoredRemote]
  )

  useEffect(() => {
    if (!open) return
    void refresh()
    return () => {
      void window.electronAPI?.disconnectRemote?.(server.id).catch(() => {})
    }
  }, [open, server.id, refresh])

  if (!open) return null

  return (
    <div className="h-full w-[min(100%,28rem)] shrink-0 flex flex-col border-l border-border bg-card/30 min-h-0">
      <div className="px-2 py-1 flex items-center gap-1 text-xs bg-muted/30 border-b shrink-0">
        <button
          type="button"
          onClick={() => void goRemote(parentRemote(remotePath))}
          className="p-0.5 hover:bg-muted rounded"
          title="Up"
          aria-label="Up one directory"
        >
          <ArrowUp className="h-3 w-3" />
        </button>
        <span className={`flex-1 truncate ${fileFontClass}`} title={remotePath}>
          {remotePath}
        </span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      </div>

      <div
        className={`flex-1 overflow-auto min-h-0 flex flex-col ${fileFontClass}`}
        style={fileFontStyle}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wide bg-card/95 border-b border-border select-none">
          <span className="w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 text-muted-foreground">Name</span>
          <span className="w-12 shrink-0 text-muted-foreground">Type</span>
        </div>

        <div className="flex-1 p-1 min-h-0">
          {error && (
            <div className="p-2 text-xs text-red-400">
              {error}
              <button type="button" className="ml-2 underline" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          )}
          {!error &&
            entries.map(e => (
              <div
                key={e.path}
                className="flex items-center gap-2 px-2 py-1 rounded cursor-default select-none hover:bg-muted/60"
                onDoubleClick={() => {
                  if (e.type === 'dir' || e.type === 'link') void goRemote(e.path)
                }}
                title={entryTooltip(e)}
              >
                {e.type === 'dir' ? (
                  <Folder className="h-4 w-4 shrink-0 text-accent pointer-events-none" aria-hidden />
                ) : (
                  <FileIcon
                    className="h-4 w-4 shrink-0 text-muted-foreground pointer-events-none"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1 overflow-x-hidden text-ellipsis whitespace-nowrap pointer-events-none">
                  {e.name}
                </span>
                <span className="text-[10px] text-muted-foreground w-12 truncate pointer-events-none shrink-0">
                  {entryTypeLabel(e)}
                </span>
              </div>
            ))}
          {!error && !loading && entries.length === 0 && (
            <div className="p-2 text-muted-foreground text-xs">Empty</div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2 flex items-center justify-end bg-muted/20">
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
        >
          Close
        </button>
      </div>
    </div>
  )
}

export default SshSftpSidebar
