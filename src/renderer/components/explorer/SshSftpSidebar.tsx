import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Server, DEFAULT_FILES_SETTINGS } from '@shared/types'
import type { FileEntry, FileFontStyle } from '@shared/types'
import { ArrowUp, Folder, File as FileIcon, Loader2 } from 'lucide-react'
import { useExplorerStore } from '../../store/explorerStore'
import { useTransferStore } from '../../store/transferStore'

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

function joinRemote(dirPath: string, name: string): string {
  return dirPath.endsWith('/') ? dirPath + name : dirPath + '/' + name
}

/**
 * Remote-only SFTP browser for SSH sessions — matches DualPaneExplorer remote pane styling,
 * including OS ↔ remote drag-and-drop.
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
  const enqueueTransfer = useTransferStore(s => s.enqueue)
  const transfers = useTransferStore(s => s.transfers)

  const [remotePath, setRemotePath] = useState(stored.remotePath)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [dropActive, setDropActive] = useState(false)
  const [preparingDrag, setPreparingDrag] = useState(false)

  const pathRef = useRef(remotePath)
  pathRef.current = remotePath
  const anchorRef = useRef<number | null>(null)
  const pointerDownRef = useRef(false)
  const remoteDragSessionRef = useRef(0)
  const prevCompletedRef = useRef<Set<string>>(new Set())

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
      setSelected(new Set())
      anchorRef.current = null
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

  // Refresh listing when uploads for this server complete
  useEffect(() => {
    if (!open) return
    const completed = transfers.filter(
      t => t.serverId === server.id && (t.status === 'completed' || t.status === 'failed')
    )
    let shouldRefresh = false
    for (const t of completed) {
      if (!prevCompletedRef.current.has(t.id)) {
        prevCompletedRef.current.add(t.id)
        if (t.status === 'completed') shouldRefresh = true
      }
    }
    if (shouldRefresh) void refresh()
  }, [transfers, server.id, open, refresh])

  // Track pointer so we only start OS drag-out if the user is still holding.
  useEffect(() => {
    if (!open) return
    const onDown = () => { pointerDownRef.current = true }
    const onUp = () => {
      pointerDownRef.current = false
      remoteDragSessionRef.current += 1
      setPreparingDrag(false)
      window.electronAPI.cancelNativeDrag()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }
  }, [open])

  const enqueueFile = (localFilePath: string, remoteFilePath: string, bytesTotal = 0) => {
    enqueueTransfer({
      serverId: server.id,
      serverName: server.name,
      direction: 'up',
      localPath: localFilePath,
      remotePath: remoteFilePath,
      bytesTotal,
    })
  }

  const uploadDirectory = async (entry: FileEntry) => {
    const remoteRoot = joinRemote(remotePath, entry.name)
    await window.electronAPI.mkdirRemote(server.id, remoteRoot)

    const walk = async (localDir: string, remoteDir: string) => {
      let children: FileEntry[] = []
      try {
        children = await window.electronAPI.listLocal(localDir)
      } catch (e) {
        console.warn(e)
        return
      }
      for (const child of children) {
        const remoteChild = joinRemote(remoteDir, child.name)
        if (child.type === 'dir') {
          await window.electronAPI.mkdirRemote(server.id, remoteChild)
          await walk(child.path, remoteChild)
        } else {
          enqueueFile(child.path, remoteChild, child.size || 0)
        }
      }
    }
    await walk(entry.path, remoteRoot)
  }

  const uploadEntry = async (entry: FileEntry) => {
    if (entry.type === 'dir') {
      await uploadDirectory(entry)
      return
    }
    enqueueFile(entry.path, joinRemote(remotePath, entry.name), entry.size || 0)
  }

  const importOsPaths = async (paths: string[]) => {
    for (const p of paths) {
      const entry = await window.electronAPI.statLocal(p)
      if (!entry) continue
      await uploadEntry(entry)
    }
  }

  const handleItemClick = (e: React.MouseEvent, entry: FileEntry, index: number) => {
    e.preventDefault()
    const multi = e.ctrlKey || e.metaKey

    if (e.shiftKey && anchorRef.current != null) {
      const start = Math.min(anchorRef.current, index)
      const end = Math.max(anchorRef.current, index)
      const next = multi ? new Set(selected) : new Set<string>()
      for (let i = start; i <= end; i++) next.add(entries[i].path)
      setSelected(next)
    } else if (multi) {
      const next = new Set(selected)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      setSelected(next)
      anchorRef.current = index
    } else {
      setSelected(new Set([entry.path]))
      anchorRef.current = index
    }
  }

  const onRowDragStart = (e: React.DragEvent, entry: FileEntry) => {
    let dragEntries: FileEntry[]
    if (selected.has(entry.path) && selected.size > 0) {
      dragEntries = entries.filter(en => selected.has(en.path))
    } else {
      dragEntries = [entry]
      setSelected(new Set([entry.path]))
    }
    if (dragEntries.length === 0) {
      e.preventDefault()
      return
    }

    // Native drag-out requires preventDefault.
    e.preventDefault()

    const session = ++remoteDragSessionRef.current
    pointerDownRef.current = true
    setPreparingDrag(true)
    void (async () => {
      try {
        const paths = await window.electronAPI.prepareRemoteDrag(
          server.id,
          dragEntries.map(en => ({
            name: en.name,
            path: en.path,
            type: en.type,
            size: en.size,
          }))
        )
        if (session !== remoteDragSessionRef.current) return
        if (!pointerDownRef.current) return
        if (!paths || paths.length === 0) return
        window.electronAPI.startNativeDrag({ kind: 'local', paths })
      } catch (err) {
        console.warn('prepareRemoteDrag failed', err)
      } finally {
        if (session === remoteDragSessionRef.current) setPreparingDrag(false)
      }
    })()
  }

  const hasOsFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files')

  const onDragOver = (e: React.DragEvent) => {
    if (!hasOsFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null
    if (related && (e.currentTarget as Node).contains(related)) return
    setDropActive(false)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDropActive(false)
    const fileList = e.dataTransfer.files
    if (!fileList || fileList.length === 0) return
    const paths: string[] = []
    for (let i = 0; i < fileList.length; i++) {
      try {
        const p = window.electronAPI.getPathForFile(fileList[i])
        if (p) paths.push(p)
      } catch (err) {
        console.warn('getPathForFile failed', err)
      }
    }
    if (paths.length === 0) return
    void importOsPaths(paths)
  }

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
        {preparingDrag && (
          <span className="text-[10px] text-accent shrink-0 animate-pulse">Preparing drag…</span>
        )}
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      </div>

      <div
        className={`flex-1 overflow-auto min-h-0 flex flex-col ${fileFontClass} ${
          dropActive ? 'bg-accent/10 ring-1 ring-inset ring-accent/40' : ''
        }`}
        style={fileFontStyle}
        onClick={() => {
          setSelected(new Set())
          anchorRef.current = null
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
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
            entries.map((e, idx) => {
              const isSelected = selected.has(e.path)
              return (
                <div
                  key={e.path}
                  draggable
                  className={`flex items-center gap-2 px-2 py-1 rounded cursor-default select-none ${
                    isSelected ? 'bg-accent/25 text-foreground' : 'hover:bg-muted/60'
                  }`}
                  onClick={ev => {
                    ev.stopPropagation()
                    handleItemClick(ev, e, idx)
                  }}
                  onDoubleClick={() => {
                    if (e.type === 'dir' || e.type === 'link') void goRemote(e.path)
                  }}
                  onDragStart={ev => onRowDragStart(ev, e)}
                  onDragEnd={() => {
                    // preventDefault on dragstart may fire dragend immediately — don't cancel prepare here.
                    setDropActive(false)
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
              )
            })}
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
