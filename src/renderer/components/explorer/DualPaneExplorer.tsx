import { useEffect, useState, useCallback, useImperativeHandle, forwardRef, useRef, useMemo } from 'react'
import { Server } from '@shared/types'
import type { ExploreProgressEvent, FileEntry, RemoteCacheEntry } from '@shared/types'
import { ArrowUp, FolderPlus, Upload, Download, Pencil, Trash2, Shield } from 'lucide-react'
import { useTransferStore } from '../../store/transferStore'
import { useExplorerStore } from '../../store/explorerStore'
import PermissionsDialog from './PermissionsDialog'

interface DualPaneExplorerProps {
  server: Server
  onStatusChange?: (status: { loading: boolean; isExploring: boolean }) => void
  onConnected?: () => void
  onConnectFailed?: () => void
}

export type DualPaneExplorerHandle = {
  refresh: () => void
  exploreFullTree: () => void
}

type PaneSide = 'local' | 'remote'

type ContextMenuState = {
  x: number
  y: number
  side: PaneSide
  /** Entry under the cursor when the menu opened. */
  entry: FileEntry
}

const DND_MIME = 'application/x-puppyftp-files'

type DragPayload = {
  side: PaneSide
  entries: FileEntry[]
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
}

function parentDir(filePath: string, isLocal: boolean): string {
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return isLocal ? 'C:/' : '/'
  const parent = normalized.slice(0, idx)
  if (isLocal && /^[A-Za-z]:$/.test(parent)) return parent + '/'
  return parent || (isLocal ? 'C:/' : '/')
}

function joinName(dirPath: string, name: string, isLocal: boolean): string {
  if (isLocal) {
    const base = dirPath.replace(/\\/g, '/')
    return base.endsWith('/') ? base + name : base + '/' + name
  }
  return dirPath.endsWith('/') ? dirPath + name : dirPath + '/' + name
}

const DualPaneExplorer = forwardRef<DualPaneExplorerHandle, DualPaneExplorerProps>(function DualPaneExplorer(
  { server, onStatusChange, onConnected, onConnectFailed },
  ref
) {
  const stored = useExplorerStore.getState().getPaths(server.id)
  const setStoredLocal = useExplorerStore(s => s.setLocalPath)
  const setStoredRemote = useExplorerStore(s => s.setRemotePath)

  const [localPath, setLocalPath] = useState(stored.localPath)
  const [remotePath, setRemotePath] = useState(stored.remotePath)
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([])
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const enqueueTransfer = useTransferStore(s => s.enqueue)
  const transfers = useTransferStore(s => s.transfers)

  const [localSelected, setLocalSelected] = useState<Set<string>>(() => new Set())
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(() => new Set())
  const localAnchorRef = useRef<number | null>(null)
  const remoteAnchorRef = useRef<number | null>(null)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [permissionsEntry, setPermissionsEntry] = useState<FileEntry | null>(null)
  const [dropTarget, setDropTarget] = useState<PaneSide | null>(null)
  const dragPayloadRef = useRef<DragPayload | null>(null)

  // Phase 4
  const [cachedTree, setCachedTree] = useState<Record<string, RemoteCacheEntry>>({})
  const [exploreProgress, setExploreProgress] = useState<{ percent: number; status: string; currentPath?: string } | null>(null)
  const [isExploring, setIsExploring] = useState(false)
  const announcedRef = useRef(false)
  const onConnectedRef = useRef(onConnected)
  const onConnectFailedRef = useRef(onConnectFailed)
  const prevCompletedRef = useRef<Set<string>>(new Set())
  onConnectedRef.current = onConnected
  onConnectFailedRef.current = onConnectFailed

  const sortedLocal = useMemo(() => sortEntries(localEntries), [localEntries])
  const sortedRemote = useMemo(() => sortEntries(remoteEntries), [remoteEntries])

  const refreshLocal = useCallback(async (p = localPath) => {
    try {
      const list = await window.electronAPI.listLocal(p)
      setLocalEntries(list)
    } catch (e) { console.warn(e) }
  }, [localPath])

  const refreshRemote = useCallback(async (p = remotePath) => {
    try {
      const list = await window.electronAPI.listRemote(server.id, p)
      if (list == null) {
        if (!announcedRef.current) {
          announcedRef.current = true
          onConnectFailedRef.current?.()
        }
        return false
      }
      setRemoteEntries(list)
      if (!announcedRef.current) {
        announcedRef.current = true
        onConnectedRef.current?.()
      }
      return true
    } catch (e) {
      console.warn(e)
      if (!announcedRef.current) {
        announcedRef.current = true
        onConnectFailedRef.current?.()
      }
      return false
    }
  }, [remotePath, server.id])

  const loadCache = useCallback(async () => {
    try {
      const tree = await window.electronAPI.getCachedTree(server.id)
      setCachedTree(tree || {})
    } catch (e) {
      console.warn('loadCache failed', e)
    }
  }, [server.id])

  const load = useCallback(async () => {
    setLoading(true)
    await Promise.all([refreshLocal(), refreshRemote(), loadCache()])
    setLoading(false)
  }, [refreshLocal, refreshRemote, loadCache])

  useEffect(() => {
    onStatusChange?.({ loading, isExploring })
  }, [loading, isExploring, onStatusChange])

  // Phase 4: Explore full tree
  const exploreFullTree = useCallback(async () => {
    const confirmed = confirm(
      `WARNING: This will recursively explore the entire remote tree starting from ${remotePath}.\n\n` +
      'On large servers this can take a long time, use CPU/IO on the remote, and generate a lot of data.\n\n' +
      'Continue?'
    )
    if (!confirmed) return

    setIsExploring(true)
    setExploreProgress({ percent: 0, status: 'starting' })
    try {
      await window.electronAPI.exploreRemoteTree(server.id, remotePath)
      await loadCache()
    } finally {
      setIsExploring(false)
    }
  }, [remotePath, server.id, loadCache])

  useImperativeHandle(ref, () => ({
    refresh: () => { void load() },
    exploreFullTree: () => { void exploreFullTree() },
  }), [load, exploreFullTree])

  useEffect(() => {
    load()

    const unsubExplore = window.electronAPI.onExploreProgress?.((data: ExploreProgressEvent) => {
      if (data.serverId === server.id) {
        setExploreProgress({ percent: data.percent, status: data.status, currentPath: data.currentPath })
        if (data.percent >= 100 || data.status === 'done' || data.status === 'cancelled') {
          setIsExploring(false)
          setTimeout(() => {
            setExploreProgress(null)
            loadCache()
            refreshRemote()
          }, 500)
        }
      }
    })

    return () => {
      unsubExplore?.()
    }
  }, [server.id, load, refreshRemote, loadCache])

  // Refresh panes when a transfer for this server completes
  useEffect(() => {
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
    if (shouldRefresh) {
      void refreshLocal()
      void refreshRemote()
    }
  }, [transfers, server.id, refreshLocal, refreshRemote])

  // Close context menu on outside click / escape
  useEffect(() => {
    if (!contextMenu) return
    const onPointerDown = (e: MouseEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return
      setContextMenu(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu])

  // Navigation
  const goLocal = async (newPath: string) => {
    setLocalPath(newPath)
    setStoredLocal(newPath)
    setLocalSelected(new Set())
    localAnchorRef.current = null
    await refreshLocal(newPath)
  }

  const goRemote = async (newPath: string) => {
    setRemotePath(newPath)
    setStoredRemote(server.id, newPath)
    setRemoteSelected(new Set())
    remoteAnchorRef.current = null
    await refreshRemote(newPath)
  }

  const upLocal = () => {
    const parts = localPath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length > 1) {
      const up = parts.slice(0, -1).join('/') || 'C:/'
      goLocal(up.startsWith('C:') ? up : 'C:/' + up)
    }
  }

  const upRemote = () => {
    const parts = remotePath.split('/').filter(Boolean)
    const up = '/' + parts.slice(0, -1).join('/')
    goRemote(up || '/')
  }

  // Selection
  const getSelection = (side: PaneSide) => (side === 'local' ? localSelected : remoteSelected)
  const setSelection = (side: PaneSide, next: Set<string>) => {
    if (side === 'local') setLocalSelected(next)
    else setRemoteSelected(next)
  }
  const getAnchor = (side: PaneSide) => (side === 'local' ? localAnchorRef : remoteAnchorRef)
  const getSorted = (side: PaneSide) => (side === 'local' ? sortedLocal : sortedRemote)

  const handleItemClick = (
    e: React.MouseEvent,
    side: PaneSide,
    entry: FileEntry,
    index: number
  ) => {
    e.preventDefault()
    setContextMenu(null)
    const sorted = getSorted(side)
    const selected = getSelection(side)
    const anchorRef = getAnchor(side)
    const multi = e.ctrlKey || e.metaKey

    if (e.shiftKey && anchorRef.current != null) {
      const start = Math.min(anchorRef.current, index)
      const end = Math.max(anchorRef.current, index)
      const next = multi ? new Set(selected) : new Set<string>()
      for (let i = start; i <= end; i++) next.add(sorted[i].path)
      setSelection(side, next)
    } else if (multi) {
      const next = new Set(selected)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      setSelection(side, next)
      anchorRef.current = index
    } else {
      setSelection(side, new Set([entry.path]))
      anchorRef.current = index
    }

    // Clear selection on the other pane
    if (side === 'local') setRemoteSelected(new Set())
    else setLocalSelected(new Set())
  }

  const handleItemDoubleClick = (side: PaneSide, entry: FileEntry) => {
    if (entry.type === 'dir') {
      if (side === 'local') void goLocal(entry.path)
      else void goRemote(entry.path)
    }
  }

  const clearPaneSelection = (side: PaneSide) => {
    setSelection(side, new Set())
    getAnchor(side).current = null
  }

  // Actions
  const mkdirLocal = async () => {
    const name = prompt('New folder name')
    if (!name) return
    const p = localPath + (localPath.endsWith('/') || localPath.endsWith('\\') ? '' : '/') + name
    await window.electronAPI.mkdirLocal(p)
    refreshLocal()
  }

  const mkdirRemote = async () => {
    const name = prompt('New folder name')
    if (!name) return
    const p = remotePath.endsWith('/') ? remotePath + name : remotePath + '/' + name
    await window.electronAPI.mkdirRemote(server.id, p)
    refreshRemote()
  }

  const deleteItems = async (side: PaneSide, entries: FileEntry[]) => {
    if (entries.length === 0) return
    const label =
      entries.length === 1
        ? entries[0].name
        : `${entries.length} items`
    if (!confirm(`Delete ${label}?`)) return
    for (const entry of entries) {
      if (side === 'local') await window.electronAPI.deleteLocal(entry.path)
      else await window.electronAPI.deleteRemote(server.id, entry.path)
    }
    setSelection(side, new Set())
    if (side === 'local') refreshLocal()
    else refreshRemote()
  }

  const renameItem = async (side: PaneSide, entry: FileEntry) => {
    const name = prompt('Rename to', entry.name)
    if (!name || name === entry.name) return
    const isLocal = side === 'local'
    const newPath = joinName(parentDir(entry.path, isLocal), name, isLocal)
    const ok = isLocal
      ? await window.electronAPI.renameLocal(entry.path, newPath)
      : await window.electronAPI.renameRemote(server.id, entry.path, newPath)
    if (!ok) {
      alert('Rename failed')
      return
    }
    setSelection(side, new Set())
    if (isLocal) refreshLocal()
    else refreshRemote()
  }

  const saveRemotePermissions = async (entry: FileEntry, modeOctal: string) => {
    const ok = await window.electronAPI.chmodRemote(server.id, entry.path, modeOctal)
    if (ok) await refreshRemote()
    return ok
  }

  const enqueueFile = (
    isUpload: boolean,
    localFilePath: string,
    remoteFilePath: string,
    bytesTotal = 0
  ) => {
    enqueueTransfer({
      serverId: server.id,
      serverName: server.name,
      direction: isUpload ? 'up' : 'down',
      localPath: localFilePath,
      remotePath: remoteFilePath,
      bytesTotal,
    })
  }

  /** Recursively expand a directory into mkdir + per-file transfer jobs. */
  const transferDirectory = async (isUpload: boolean, entry: FileEntry) => {
    if (isUpload) {
      const remoteRoot = joinName(remotePath, entry.name, false)
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
          const remoteChild = joinName(remoteDir, child.name, false)
          if (child.type === 'dir') {
            await window.electronAPI.mkdirRemote(server.id, remoteChild)
            await walk(child.path, remoteChild)
          } else {
            enqueueFile(true, child.path, remoteChild, child.size || 0)
          }
        }
      }
      await walk(entry.path, remoteRoot)
    } else {
      const localRoot = joinName(localPath.replace(/\\/g, '/'), entry.name, true)
      await window.electronAPI.mkdirLocal(localRoot)

      const walk = async (remoteDir: string, localDir: string) => {
        let children: FileEntry[] = []
        try {
          children = (await window.electronAPI.listRemote(server.id, remoteDir)) ?? []
        } catch (e) {
          console.warn(e)
          return
        }
        for (const child of children) {
          const localChild = joinName(localDir, child.name, true)
          if (child.type === 'dir') {
            await window.electronAPI.mkdirLocal(localChild)
            await walk(child.path, localChild)
          } else {
            enqueueFile(false, localChild, child.path, child.size || 0)
          }
        }
      }
      await walk(entry.path, localRoot)
    }
  }

  const transferEntry = async (isUpload: boolean, entry: FileEntry) => {
    if (entry.type === 'dir') {
      await transferDirectory(isUpload, entry)
      return
    }
    if (isUpload) {
      const target = joinName(remotePath, entry.name, false)
      enqueueFile(true, entry.path, target, entry.size || 0)
    } else {
      const target = joinName(localPath.replace(/\\/g, '/'), entry.name, true)
      enqueueFile(false, target, entry.path, entry.size || 0)
    }
  }

  const transferEntries = (isUpload: boolean, entries: FileEntry[]) => {
    void (async () => {
      for (const entry of entries) {
        await transferEntry(isUpload, entry)
      }
    })()
  }

  const entriesForSelection = (side: PaneSide, fallback?: FileEntry): FileEntry[] => {
    const selected = getSelection(side)
    const sorted = getSorted(side)
    if (selected.size > 0) {
      return sorted.filter(e => selected.has(e.path))
    }
    return fallback ? [fallback] : []
  }

  const cancelExplore = async () => {
    await window.electronAPI.cancelExplore(server.id)
    setIsExploring(false)
    setExploreProgress({ percent: 100, status: 'cancelled' })
    setTimeout(() => setExploreProgress(null), 800)
  }

  const clearRemoteCache = async () => {
    if (!confirm('Clear cached tree for this server?')) return
    await window.electronAPI.clearCache(server.id)
    setCachedTree({})
  }

  // Context menu
  const openContextMenu = (e: React.MouseEvent, side: PaneSide, entry: FileEntry, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    const selected = getSelection(side)
    if (!selected.has(entry.path)) {
      setSelection(side, new Set([entry.path]))
      getAnchor(side).current = index
      if (side === 'local') setRemoteSelected(new Set())
      else setLocalSelected(new Set())
    }
    setContextMenu({ x: e.clientX, y: e.clientY, side, entry })
  }

  // Drag and drop
  const onRowDragStart = (e: React.DragEvent, side: PaneSide, entry: FileEntry) => {
    const selected = getSelection(side)
    let entries: FileEntry[]
    if (selected.has(entry.path) && selected.size > 0) {
      entries = getSorted(side).filter(en => selected.has(en.path))
    } else {
      entries = [entry]
      setSelection(side, new Set([entry.path]))
    }
    if (entries.length === 0) {
      e.preventDefault()
      return
    }
    const payload: DragPayload = { side, entries }
    dragPayloadRef.current = payload
    e.dataTransfer.setData(DND_MIME, JSON.stringify(payload))
    e.dataTransfer.setData('text/plain', entries.map(f => f.name).join(', '))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const onPaneDragOver = (e: React.DragEvent, side: PaneSide) => {
    const raw = e.dataTransfer.types.includes(DND_MIME) || dragPayloadRef.current
    if (!raw) return
    const payload = dragPayloadRef.current
    // Only allow drops from the opposite pane
    if (payload && payload.side === side) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropTarget(side)
  }

  const onPaneDragLeave = (e: React.DragEvent, side: PaneSide) => {
    const related = e.relatedTarget as Node | null
    if (related && (e.currentTarget as Node).contains(related)) return
    if (dropTarget === side) setDropTarget(null)
  }

  const onPaneDrop = (e: React.DragEvent, side: PaneSide) => {
    e.preventDefault()
    setDropTarget(null)
    let payload = dragPayloadRef.current
    try {
      const raw = e.dataTransfer.getData(DND_MIME)
      if (raw) payload = JSON.parse(raw) as DragPayload
    } catch { /* use ref */ }
    dragPayloadRef.current = null
    if (!payload || payload.side === side) return
    const isUpload = payload.side === 'local'
    transferEntries(isUpload, payload.entries)
  }

  const renderList = (side: PaneSide) => {
    const entries = side === 'local' ? sortedLocal : sortedRemote
    const selected = getSelection(side)
    const isLocal = side === 'local'

    return (
      <div
        className={`flex-1 overflow-auto text-sm p-1 font-mono min-h-0 ${
          dropTarget === side ? 'bg-accent/10 ring-1 ring-inset ring-accent/40' : ''
        }`}
        onClick={() => clearPaneSelection(side)}
        onDragOver={e => onPaneDragOver(e, side)}
        onDragLeave={e => onPaneDragLeave(e, side)}
        onDrop={e => onPaneDrop(e, side)}
      >
        {entries.map((e, idx) => {
          const isSelected = selected.has(e.path)
          return (
            <div
              key={e.path}
              draggable
              className={`flex items-center gap-2 px-2 py-0.5 rounded cursor-default group select-none ${
                isSelected ? 'bg-accent/25 text-foreground' : 'hover:bg-muted/60'
              }`}
              onClick={ev => {
                ev.stopPropagation()
                handleItemClick(ev, side, e, idx)
              }}
              onDoubleClick={ev => {
                ev.stopPropagation()
                handleItemDoubleClick(side, e)
              }}
              onContextMenu={ev => openContextMenu(ev, side, e, idx)}
              onDragStart={ev => onRowDragStart(ev, side, e)}
              onDragEnd={() => {
                dragPayloadRef.current = null
                setDropTarget(null)
              }}
            >
              <span className="flex-1 truncate pointer-events-none">
                {e.name}{e.type === 'dir' ? '/' : ''}
              </span>
              <span className="text-[10px] text-muted-foreground w-16 text-right pointer-events-none">
                {e.type === 'dir' ? '' : ((e.size || 0) / 1024).toFixed(1) + 'k'}
              </span>
              <button
                type="button"
                onClick={ev => {
                  ev.stopPropagation()
                  const toSend =
                    selected.has(e.path) && selected.size > 1
                      ? entriesForSelection(side)
                      : [e]
                  transferEntries(isLocal, toSend)
                }}
                className="opacity-0 group-hover:opacity-100 p-1.5 text-accent hover:bg-accent/15 rounded"
                title={isLocal ? 'Upload' : 'Download'}
              >
                {isLocal
                  ? <Upload className="h-5 w-5" />
                  : <Download className="h-5 w-5" />}
              </button>
            </div>
          )
        })}
        {entries.length === 0 && <div className="p-2 text-muted-foreground text-xs">Empty</div>}
      </div>
    )
  }

  const menuEntries = contextMenu
    ? entriesForSelection(contextMenu.side, contextMenu.entry)
    : []
  const menuIsLocal = contextMenu?.side === 'local'

  return (
    <div className="h-full flex flex-col min-h-0">
      {exploreProgress && (
        <div className="px-3 py-1 flex items-center justify-center gap-3 bg-surface-elevated border-b text-[10px]">
          <div className="text-orange-400 flex items-center gap-1">
            Exploring {exploreProgress.percent}% — {exploreProgress.currentPath?.slice(-30) || exploreProgress.status}
            {isExploring && (
              <button onClick={cancelExplore} className="underline ml-1">Cancel</button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 grid grid-cols-2 min-h-0">
        {/* Local */}
        <div className="border-r border-border flex flex-col bg-card/30 min-h-0">
          <div className="px-2 py-1 flex items-center gap-1 text-xs bg-muted/30 border-b">
            <button onClick={upLocal} className="p-0.5 hover:bg-muted"><ArrowUp className="h-3 w-3" /></button>
            <span className="flex-1 truncate font-mono" title={localPath}>{localPath}</span>
            <button onClick={mkdirLocal} className="p-0.5 hover:bg-muted" title="New folder"><FolderPlus className="h-3 w-3" /></button>
          </div>
          {renderList('local')}
        </div>

        {/* Remote */}
        <div className="flex flex-col bg-card/30 min-h-0">
          <div className="px-2 py-1 flex items-center gap-1 text-xs bg-muted/30 border-b">
            <button onClick={upRemote} className="p-0.5 hover:bg-muted"><ArrowUp className="h-3 w-3" /></button>
            <span className="flex-1 truncate font-mono" title={remotePath}>{remotePath}</span>
            <button onClick={mkdirRemote} className="p-0.5 hover:bg-muted" title="New folder"><FolderPlus className="h-3 w-3" /></button>
          </div>

          {renderList('remote')}

          {Object.keys(cachedTree).length > 0 && (
            <div className="text-[9px] px-2 py-0.5 text-muted-foreground border-t flex items-center justify-between gap-2">
              <span>Cached tree available ({Object.keys(cachedTree).length} entries)</span>
              <button onClick={clearRemoteCache} className="text-red-400 hover:underline shrink-0">Clear cache</button>
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[60] min-w-[160px] rounded-md border border-border bg-card py-1 shadow-lg text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left disabled:opacity-40 disabled:pointer-events-none"
            disabled={menuEntries.length === 0}
            onClick={() => {
              transferEntries(!!menuIsLocal, menuEntries)
              setContextMenu(null)
            }}
          >
            {menuIsLocal
              ? <Upload className="h-3.5 w-3.5" />
              : <Download className="h-3.5 w-3.5" />}
            {menuIsLocal ? 'Upload' : 'Download'}
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left disabled:opacity-40 disabled:pointer-events-none"
            disabled={menuEntries.length !== 1}
            onClick={() => {
              if (contextMenu) void renameItem(contextMenu.side, contextMenu.entry)
              setContextMenu(null)
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
          {!menuIsLocal && (
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left disabled:opacity-40 disabled:pointer-events-none"
              disabled={menuEntries.length !== 1}
              onClick={() => {
                if (contextMenu) setPermissionsEntry(contextMenu.entry)
                setContextMenu(null)
              }}
            >
              <Shield className="h-3.5 w-3.5" />
              Permissions
            </button>
          )}
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left text-red-400"
            onClick={() => {
              if (contextMenu) void deleteItems(contextMenu.side, menuEntries)
              setContextMenu(null)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      )}

      {permissionsEntry && (
        <PermissionsDialog
          entry={permissionsEntry}
          onClose={() => setPermissionsEntry(null)}
          onSave={modeOctal => saveRemotePermissions(permissionsEntry, modeOctal)}
        />
      )}
    </div>
  )
})

export default DualPaneExplorer
