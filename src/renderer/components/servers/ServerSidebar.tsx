import React, { useEffect, useRef, useState } from 'react'
import {
  AuthKey,
  AuthMethod,
  ConnectionMethod,
  ConnectionType,
  Protocol,
  Server,
  Category,
  SerialDataBits,
  SerialParity,
  SerialPortInfo,
  SerialStopBits,
  UNCATEGORIZED_ID,
  DEFAULT_SERIAL_BAUD_RATE,
  DEFAULT_SERIAL_DATA_BITS,
  DEFAULT_SERIAL_PARITY,
  DEFAULT_SERIAL_STOP_BITS,
  defaultPortForProtocol,
  isSerialConnection,
  isTerminalProtocol,
  protocolLabel,
} from '@shared/types'
import { Plus, Trash2, Terminal, ArrowLeftRight, Monitor, ChevronDown, ChevronRight, KeyRound, Pencil } from 'lucide-react'

function ServerTypeIcon({ protocol }: { protocol: Protocol }) {
  if (isTerminalProtocol(protocol)) {
    return <Terminal className="h-4 w-4 flex-shrink-0" aria-hidden />
  }
  if (protocol === 'rdp') {
    return <Monitor className="h-4 w-4 flex-shrink-0" aria-hidden />
  }
  return <ArrowLeftRight className="h-4 w-4 flex-shrink-0" aria-hidden />
}

interface ServerSidebarProps {
  servers: Server[]
  categories: Category[]
  selectedServerId: string | null
  connectionByServerId: Record<string, 'connecting' | 'connected' | 'lost' | 'failed'>
  onSelectServer: (id: string) => void
  onConnectServer: (id: string) => void
  onAddServer: (data: Omit<Server, 'id' | 'createdAt' | 'order'>) => Promise<void>
  onDeleteServer: (id: string) => Promise<void>
  onDeleteServers: (ids: string[]) => Promise<void>
  onUpdateServers: (servers: Server[]) => Promise<void>
  onUpdateCategories: (categories: Category[]) => Promise<void>
  showAddModal: boolean
  setShowAddModal: (open: boolean) => void
  authKeys: AuthKey[]
  onOpenAuthSettings: () => void
}

const FILE_TRANSFER_PROTOCOLS: { value: Protocol; label: string }[] = [
  { value: 'sftp', label: 'SFTP (SSH File Transfer Protocol)' },
  { value: 'ftps', label: 'FTP w/explicit TLS' },
  { value: 'ftps-implicit', label: 'FTP w/implicit TLS' },
  { value: 'ftp', label: 'FTP (insecure)' },
]

const TERMINAL_PROTOCOLS: { value: Protocol; label: string }[] = [
  { value: 'ssh', label: 'SSH' },
  { value: 'telnet', label: 'Telnet (insecure)' },
]

const BAUD_PRESETS = [9600, 19200, 38400, 57600, 115200]

const emptyForm = {
  connectionType: '' as ConnectionType | '',
  connectionMethod: 'network' as ConnectionMethod,
  name: '',
  protocol: 'sftp' as Protocol,
  host: '',
  /** Empty string while the user is clearing/retyping; resolved on save. */
  port: 22 as number | '',
  username: '',
  domain: '',
  categoryId: UNCATEGORIZED_ID,
  authMethod: 'password' as AuthMethod,
  password: '',
  keyId: '',
  lastKnownOs: '',
  allowInvalidCertificate: false,
  serialPort: '',
  baudRate: DEFAULT_SERIAL_BAUD_RATE as number | '',
  dataBits: DEFAULT_SERIAL_DATA_BITS as SerialDataBits,
  parity: DEFAULT_SERIAL_PARITY as SerialParity,
  stopBits: DEFAULT_SERIAL_STOP_BITS as SerialStopBits,
  showSerialAdvanced: false,
}

function resolveFormPort(port: number | '', protocol: Protocol): number {
  return typeof port === 'number' && port > 0 ? port : defaultPortForProtocol(protocol)
}

function resolveFormBaud(baud: number | ''): number {
  return typeof baud === 'number' && baud > 0 ? baud : DEFAULT_SERIAL_BAUD_RATE
}

function formFromServer(server: Server) {
  const connectionType: ConnectionType = isTerminalProtocol(server.protocol)
    ? 'terminal'
    : server.protocol === 'rdp'
      ? 'desktop'
      : 'file'
  const connectionMethod: ConnectionMethod = isSerialConnection(server) ? 'serial' : 'network'
  return {
    connectionType,
    connectionMethod,
    name: server.name,
    protocol: server.protocol,
    host: server.host,
    port: server.port,
    username: server.username || '',
    domain: server.domain || '',
    categoryId: server.categoryId || UNCATEGORIZED_ID,
    authMethod: (server.authMethod || (server.keyId ? 'privateKey' : 'password')) as AuthMethod,
    password: server.password || '',
    keyId: server.keyId || '',
    lastKnownOs: server.lastKnownOs || '',
    allowInvalidCertificate: server.allowInvalidCertificate === true,
    serialPort: server.serialPort || '',
    baudRate: server.baudRate ?? DEFAULT_SERIAL_BAUD_RATE,
    dataBits: server.dataBits ?? DEFAULT_SERIAL_DATA_BITS,
    parity: server.parity ?? DEFAULT_SERIAL_PARITY,
    stopBits: server.stopBits ?? DEFAULT_SERIAL_STOP_BITS,
    showSerialAdvanced: false,
  }
}

function serverEndpointLabel(server: Server): string {
  if (isSerialConnection(server)) {
    return `Serial · ${server.serialPort || 'COM?'}`
  }
  return `${protocolLabel(server.protocol)} · ${server.host}`
}

type CategoryMenuState = { categoryId: string; x: number; y: number } | null
type ServerMenuState = { serverId: string; x: number; y: number } | null
type CategoryModal =
  | { type: 'add' }
  | { type: 'rename'; categoryId: string; name: string }
  | {
      type: 'delete'
      categoryId: string
      disposition: 'move' | 'delete-servers'
      moveToCategoryId: string
    }
  | null

const ServerSidebar: React.FC<ServerSidebarProps> = ({
  servers,
  categories,
  selectedServerId,
  connectionByServerId,
  onSelectServer,
  onConnectServer,
  onAddServer,
  onDeleteServer,
  onDeleteServers,
  showAddModal,
  setShowAddModal,
  authKeys,
  onOpenAuthSettings,
  onUpdateServers,
  onUpdateCategories,
}) => {
  const [newServer, setNewServer] = useState(emptyForm)
  const [editingServerId, setEditingServerId] = useState<string | null>(null)
  const [categoryMenu, setCategoryMenu] = useState<CategoryMenuState>(null)
  const [serverMenu, setServerMenu] = useState<ServerMenuState>(null)
  const [categoryModal, setCategoryModal] = useState<CategoryModal>(null)
  const [categoryNameDraft, setCategoryNameDraft] = useState('')
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([])
  const [serialPortsLoading, setSerialPortsLoading] = useState(false)
  const categoryMenuRef = useRef<HTMLDivElement>(null)
  const serverMenuRef = useRef<HTMLDivElement>(null)
  // Only dismiss when press started on the backdrop — avoids closing when
  // text selection drag ends with mouseup outside the panel.
  const modalBackdropMouseDownRef = useRef(false)
  const isEditing = editingServerId != null

  const onModalBackdropMouseDown = (e: React.MouseEvent) => {
    modalBackdropMouseDownRef.current = e.target === e.currentTarget
  }

  const onModalBackdropClick = (close: () => void) => (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && modalBackdropMouseDownRef.current) {
      close()
    }
  }

  const sortedCategories = [...categories].sort((a, b) => a.order - b.order)
  const hasCustomCategories = categories.some(c => c.id !== UNCATEGORIZED_ID)

  useEffect(() => {
    if (!categoryMenu) return
    const onPointerDown = (e: MouseEvent) => {
      if (categoryMenuRef.current?.contains(e.target as Node)) return
      setCategoryMenu(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCategoryMenu(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [categoryMenu])

  useEffect(() => {
    if (!serverMenu) return
    const onPointerDown = (e: MouseEvent) => {
      if (serverMenuRef.current?.contains(e.target as Node)) return
      setServerMenu(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setServerMenu(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [serverMenu])

  const toggleCategory = async (catId: string) => {
    const updated = categories.map(c =>
      c.id === catId ? { ...c, collapsed: !c.collapsed } : c
    )
    await onUpdateCategories(updated)
  }

  const resetForm = () => {
    setNewServer(emptyForm)
    setEditingServerId(null)
  }

  useEffect(() => {
    if (!showAddModal) resetForm()
  }, [showAddModal])

  useEffect(() => {
    if (!showAddModal || newServer.connectionType !== 'terminal' || newServer.connectionMethod !== 'serial') {
      return
    }
    let cancelled = false
    setSerialPortsLoading(true)
    void window.electronAPI
      ?.listSerialPorts?.()
      .then(ports => {
        if (cancelled) return
        setSerialPorts(ports)
        setNewServer(s => {
          if (s.serialPort && ports.some(p => p.path === s.serialPort)) return s
          if (ports.length === 1 && !s.serialPort) {
            return { ...s, serialPort: ports[0]!.path }
          }
          return s
        })
      })
      .catch(() => {
        if (!cancelled) setSerialPorts([])
      })
      .finally(() => {
        if (!cancelled) setSerialPortsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [showAddModal, newServer.connectionType, newServer.connectionMethod])

  const openAddServer = () => {
    resetForm()
    setShowAddModal(true)
  }

  const openEditServer = (server: Server) => {
    setEditingServerId(server.id)
    setNewServer(formFromServer(server))
    setShowAddModal(true)
  }

  const setConnectionType = (connectionType: ConnectionType) => {
    const protocol: Protocol =
      connectionType === 'terminal' ? 'ssh' : connectionType === 'desktop' ? 'rdp' : 'sftp'
    setNewServer(s => {
      const prevDefault = defaultPortForProtocol(s.protocol)
      const keepCustom = typeof s.port === 'number' && s.port > 0 && s.port !== prevDefault
      return {
        ...s,
        connectionType,
        connectionMethod: connectionType === 'terminal' ? s.connectionMethod : 'network',
        protocol,
        port: keepCustom ? s.port : defaultPortForProtocol(protocol),
        authMethod:
          protocol === 'ssh' || protocol === 'sftp' ? s.authMethod : 'password',
        keyId:
          connectionType === 'file' && protocol !== 'sftp'
            ? ''
            : connectionType === 'desktop'
              ? ''
              : s.keyId,
        domain: connectionType === 'desktop' ? s.domain : '',
      }
    })
  }

  const setConnectionMethod = (connectionMethod: ConnectionMethod) => {
    setNewServer(s => ({
      ...s,
      connectionMethod,
      password: connectionMethod === 'serial' ? '' : s.password,
      keyId: connectionMethod === 'serial' ? '' : s.keyId,
      authMethod: connectionMethod === 'serial' ? 'password' : s.authMethod,
    }))
  }

  const setProtocol = (protocol: Protocol) => {
    const supportsKey = protocol === 'ssh' || protocol === 'sftp'
    setNewServer(s => {
      const prevDefault = defaultPortForProtocol(s.protocol)
      const keepCustom = typeof s.port === 'number' && s.port > 0 && s.port !== prevDefault
      return {
        ...s,
        protocol,
        port: keepCustom ? s.port : defaultPortForProtocol(protocol),
        authMethod: supportsKey ? s.authMethod : 'password',
        keyId: supportsKey ? s.keyId : '',
        password: protocol === 'telnet' ? '' : s.password,
      }
    })
  }

  const handleSaveServer = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newServer.connectionType || !newServer.name) return
    const isSerial =
      newServer.connectionType === 'terminal' && newServer.connectionMethod === 'serial'
    if (isSerial) {
      if (!newServer.serialPort) return
    } else if (!newServer.host) {
      return
    }
    if (!isSerial && newServer.authMethod === 'privateKey' && !newServer.keyId) return

    const selectedKey = authKeys.find(k => k.id === newServer.keyId)
    const osSuggestion = newServer.lastKnownOs.trim() || undefined

    const isTelnet = newServer.protocol === 'telnet'
    const skipAuth = isTelnet || isSerial
    const authMethod = skipAuth ? 'password' : newServer.authMethod
    const password = skipAuth
      ? undefined
      : authMethod === 'password'
        ? newServer.password || (editingServerId ? servers.find(s => s.id === editingServerId)?.password : undefined)
        : undefined
    const keyId = !skipAuth && authMethod === 'privateKey' ? newServer.keyId || undefined : undefined
    const privateKeyPath = keyId ? selectedKey?.privateKeyPath : undefined
    const passphrase = keyId ? selectedKey?.passphrase : undefined

    const serialFields = isSerial
      ? {
          connectionMethod: 'serial' as const,
          serialPort: newServer.serialPort,
          baudRate: resolveFormBaud(newServer.baudRate),
          dataBits: newServer.dataBits,
          parity: newServer.parity,
          stopBits: newServer.stopBits,
          host: newServer.host || newServer.serialPort,
          port: resolveFormPort(newServer.port, newServer.protocol),
          username: '',
        }
      : {
          connectionMethod: 'network' as const,
          serialPort: undefined,
          baudRate: undefined,
          dataBits: undefined,
          parity: undefined,
          stopBits: undefined,
          host: newServer.host,
          port: resolveFormPort(newServer.port, newServer.protocol),
          username: newServer.username,
        }

    if (editingServerId) {
      const existing = servers.find(s => s.id === editingServerId)
      if (!existing) return
      await onUpdateServers(
        servers.map(s =>
          s.id === editingServerId
            ? {
                ...s,
                name: newServer.name,
                protocol: newServer.protocol,
                ...serialFields,
                domain: newServer.protocol === 'rdp' ? newServer.domain || undefined : undefined,
                categoryId: hasCustomCategories ? newServer.categoryId : s.categoryId,
                authMethod,
                password: skipAuth
                  ? undefined
                  : authMethod === 'password'
                    ? newServer.password || s.password
                    : undefined,
                keyId,
                privateKeyPath,
                passphrase,
                lastKnownOs: osSuggestion,
                allowInvalidCertificate: newServer.allowInvalidCertificate,
              }
            : s
        )
      )
    } else {
      await onAddServer({
        name: newServer.name,
        protocol: newServer.protocol,
        ...serialFields,
        domain: newServer.protocol === 'rdp' ? newServer.domain || undefined : undefined,
        categoryId: hasCustomCategories ? newServer.categoryId : UNCATEGORIZED_ID,
        authMethod,
        password,
        keyId,
        privateKeyPath,
        passphrase,
        lastKnownOs: osSuggestion,
        allowInvalidCertificate: newServer.allowInvalidCertificate,
      })
    }
    setShowAddModal(false)
    resetForm()
  }

  const closeModal = () => {
    setShowAddModal(false)
    resetForm()
  }

  const catServers = (catId: string) =>
    servers.filter(s => s.categoryId === catId).sort((a, b) => a.order - b.order)

  const openAddCategory = () => {
    setCategoryMenu(null)
    setCategoryNameDraft('')
    setCategoryModal({ type: 'add' })
  }

  const openRenameCategory = (categoryId: string) => {
    const cat = categories.find(c => c.id === categoryId)
    if (!cat || cat.id === UNCATEGORIZED_ID) return
    setCategoryMenu(null)
    setCategoryNameDraft(cat.name)
    setCategoryModal({ type: 'rename', categoryId, name: cat.name })
  }

  const openDeleteCategory = (categoryId: string) => {
    const cat = categories.find(c => c.id === categoryId)
    if (!cat || cat.id === UNCATEGORIZED_ID) return
    const moveTargets = sortedCategories.filter(c => c.id !== categoryId)
    setCategoryMenu(null)
    setCategoryModal({
      type: 'delete',
      categoryId,
      disposition: 'move',
      moveToCategoryId: moveTargets[0]?.id ?? UNCATEGORIZED_ID,
    })
  }

  const closeCategoryModal = () => {
    setCategoryModal(null)
    setCategoryNameDraft('')
  }

  const submitAddCategory = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = categoryNameDraft.trim()
    if (!name) return
    const maxOrder = categories.reduce((max, c) => Math.max(max, c.order), -1)
    const newCat: Category = {
      id: 'cat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11),
      name,
      order: maxOrder + 1,
      collapsed: false,
    }
    await onUpdateCategories([...categories, newCat])
    closeCategoryModal()
  }

  const submitRenameCategory = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!categoryModal || categoryModal.type !== 'rename') return
    const name = categoryNameDraft.trim()
    if (!name || categoryModal.categoryId === UNCATEGORIZED_ID) return
    await onUpdateCategories(
      categories.map(c => (c.id === categoryModal.categoryId ? { ...c, name } : c))
    )
    closeCategoryModal()
  }

  const submitDeleteCategory = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!categoryModal || categoryModal.type !== 'delete') return
    const { categoryId, disposition, moveToCategoryId } = categoryModal
    if (categoryId === UNCATEGORIZED_ID) return

    const affected = servers.filter(s => s.categoryId === categoryId)
    if (disposition === 'delete-servers') {
      await onDeleteServers(affected.map(s => s.id))
    } else {
      const targetId = moveToCategoryId || UNCATEGORIZED_ID
      if (targetId === categoryId) return
      const targetCount = servers.filter(s => s.categoryId === targetId).length
      const moved = servers.map(s => {
        if (s.categoryId !== categoryId) return s
        const index = affected.findIndex(a => a.id === s.id)
        return { ...s, categoryId: targetId, order: targetCount + index }
      })
      await onUpdateServers(moved)
    }

    const remaining = categories
      .filter(c => c.id !== categoryId)
      .sort((a, b) => a.order - b.order)
      .map((c, idx) => ({ ...c, order: idx }))
    await onUpdateCategories(remaining)
    closeCategoryModal()
  }

  // Drag reorder helpers (Phase 6)
  const handleDragStart = (e: React.DragEvent, id: string, type: 'server' | 'category') => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ id, type }))
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const handleDrop = async (
    e: React.DragEvent,
    targetId: string,
    targetType: 'server' | 'category'
  ) => {
    e.preventDefault()
    const data = e.dataTransfer.getData('text/plain')
    if (!data) return
    try {
      const { id: draggedId, type: draggedType } = JSON.parse(data)
      if (draggedId === targetId) return
      if (draggedType === 'category' && targetType === 'category') {
        const catList = [...categories].sort((a, b) => a.order - b.order)
        const fromIdx = catList.findIndex(c => c.id === draggedId)
        const toIdx = catList.findIndex(c => c.id === targetId)
        if (fromIdx < 0 || toIdx < 0) return
        const [moved] = catList.splice(fromIdx, 1)
        catList.splice(toIdx, 0, moved)
        const updated = catList.map((cat, idx) => ({ ...cat, order: idx }))
        await onUpdateCategories(updated)
      } else if (draggedType === 'server' && targetType === 'server') {
        const draggedS = servers.find(s => s.id === draggedId)
        const targetS = servers.find(s => s.id === targetId)
        if (!draggedS || !targetS) return
        const updated = servers.filter(s => s.id !== draggedId).map(s => ({ ...s }))
        const tIdx = updated.findIndex(s => s.id === targetId)
        if (tIdx < 0) return
        const newS = { ...draggedS, categoryId: targetS.categoryId }
        updated.splice(tIdx, 0, newS)
        const byCat: Record<string, Server[]> = {}
        updated.forEach(s => {
          if (!byCat[s.categoryId]) byCat[s.categoryId] = []
          byCat[s.categoryId].push(s)
        })
        Object.keys(byCat).forEach(cid => {
          byCat[cid].forEach((s, i) => {
            s.order = i
          })
        })
        await onUpdateServers(updated)
      }
    } catch (err) {
      console.error('drag error', err)
    }
  }

  const supportsKeyAuth = newServer.protocol === 'ssh' || newServer.protocol === 'sftp'
  const isTelnetProtocol = newServer.protocol === 'telnet'
  const isSerialMethod =
    newServer.connectionType === 'terminal' && newServer.connectionMethod === 'serial'
  const needsKey = !isSerialMethod && supportsKeyAuth && newServer.authMethod === 'privateKey'
  const canSubmit =
    !!newServer.connectionType &&
    !!newServer.name &&
    (isSerialMethod ? !!newServer.serialPort : !!newServer.host) &&
    (!needsKey || !!newServer.keyId)

  const categoryTooltip = (cat: Category) => {
    const expandHint = cat.collapsed ? 'Left click to expand' : 'Left click to collapse'
    if (cat.id === UNCATEGORIZED_ID) return expandHint
    return `${expandHint}\nRight click to manage`
  }

  const deleteModalCategory =
    categoryModal?.type === 'delete'
      ? categories.find(c => c.id === categoryModal.categoryId)
      : null
  const deleteMoveTargets =
    categoryModal?.type === 'delete'
      ? sortedCategories.filter(c => c.id !== categoryModal.categoryId)
      : []
  const deleteAffectedCount =
    categoryModal?.type === 'delete'
      ? servers.filter(s => s.categoryId === categoryModal.categoryId).length
      : 0

  return (
    <div className="w-72 bg-sidebar border-r border-border flex flex-col h-full overflow-hidden">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <span className="font-medium text-xs uppercase tracking-widest text-muted-foreground">
          Servers
        </span>
        <button
          onClick={openAddServer}
          className="p-1 rounded hover:bg-accent/20 text-accent"
          title="Add"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 text-sm">
        {sortedCategories.map(cat => {
          const items = catServers(cat.id)
          const collapsed = !!cat.collapsed
          const isDefault = cat.id === UNCATEGORIZED_ID
          return (
            <div key={cat.id} className="mb-1">
              <div
                className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground hover:text-foreground cursor-pointer"
                draggable
                onDragStart={e => handleDragStart(e, cat.id, 'category')}
                onDragOver={handleDragOver}
                onDrop={e => handleDrop(e, cat.id, 'category')}
                onClick={() => toggleCategory(cat.id)}
              >
                {collapsed ? (
                  <ChevronRight className="h-3 w-3 flex-shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 flex-shrink-0" />
                )}
                <span
                  className="font-medium text-xs uppercase tracking-wider truncate"
                  title={categoryTooltip(cat)}
                  onContextMenu={e => {
                    if (isDefault) return
                    e.preventDefault()
                    e.stopPropagation()
                    setServerMenu(null)
                    setCategoryMenu({ categoryId: cat.id, x: e.clientX, y: e.clientY })
                  }}
                >
                  {cat.name}
                </span>
                {isDefault ? (
                  <button
                    type="button"
                    className="ml-auto p-0.5 rounded hover:bg-accent/20 text-accent"
                    title="Add category"
                    onClick={e => {
                      e.stopPropagation()
                      openAddCategory()
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <span className="ml-auto text-[10px] opacity-50">({items.length})</span>
                )}
              </div>
              {!collapsed &&
                items.map(server => (
                  <div
                    key={server.id}
                    className={`server-item ml-2 ${selectedServerId === server.id ? 'active' : ''}`}
                    onClick={() => onSelectServer(server.id)}
                    onDoubleClick={() => {
                      const status = connectionByServerId[server.id]
                      if (status === 'connected' || status === 'connecting') return
                      onConnectServer(server.id)
                    }}
                    onContextMenu={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      setCategoryMenu(null)
                      setServerMenu({ serverId: server.id, x: e.clientX, y: e.clientY })
                    }}
                  >
                    <ServerTypeIcon protocol={server.protocol} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{server.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {serverEndpointLabel(server)}
                      </div>
                    </div>
                    {connectionByServerId[server.id] === 'connecting' && (
                      <span
                        className="h-2 w-2 rounded-full bg-amber-500 flex-shrink-0 animate-pulse"
                        title="Connecting"
                        aria-label="Connecting"
                      />
                    )}
                    {connectionByServerId[server.id] === 'connected' && (
                      <span
                        className="h-2 w-2 rounded-full bg-emerald-500 flex-shrink-0"
                        title="Connected"
                        aria-label="Connected"
                      />
                    )}
                    {(connectionByServerId[server.id] === 'lost' ||
                      connectionByServerId[server.id] === 'failed') && (
                      <span
                        className="h-2 w-2 rounded-full bg-red-500 flex-shrink-0"
                        title={
                          connectionByServerId[server.id] === 'failed'
                            ? 'Unable to connect'
                            : 'Connection lost'
                        }
                        aria-label={
                          connectionByServerId[server.id] === 'failed'
                            ? 'Unable to connect'
                            : 'Connection lost'
                        }
                      />
                    )}
                  </div>
                ))}
            </div>
          )
        })}
        {servers.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-xs">
            No servers. Click + to add.
          </div>
        )}
      </div>

      {categoryMenu && (
        <div
          ref={categoryMenuRef}
          className="fixed z-[60] min-w-[140px] rounded-md border border-border bg-card py-1 shadow-lg text-sm"
          style={{ left: categoryMenu.x, top: categoryMenu.y }}
        >
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left"
            onClick={() => openRenameCategory(categoryMenu.categoryId)}
          >
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left text-red-400"
            onClick={() => openDeleteCategory(categoryMenu.categoryId)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      )}

      {serverMenu && (
        <div
          ref={serverMenuRef}
          className="fixed z-[60] min-w-[140px] rounded-md border border-border bg-card py-1 shadow-lg text-sm"
          style={{ left: serverMenu.x, top: serverMenu.y }}
        >
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left"
            onClick={() => {
              const server = servers.find(s => s.id === serverMenu.serverId)
              setServerMenu(null)
              if (server) openEditServer(server)
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            Manage
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left text-red-400"
            onClick={() => {
              const serverId = serverMenu.serverId
              setServerMenu(null)
              onDeleteServer(serverId)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      )}

      {categoryModal?.type === 'add' && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onMouseDown={onModalBackdropMouseDown}
          onClick={onModalBackdropClick(closeCategoryModal)}
        >
          <div
            className="bg-card border border-border rounded-lg w-full max-w-sm p-6"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Plus className="h-4 w-4" /> Add Category
            </h3>
            <form onSubmit={submitAddCategory} className="space-y-3">
              <input
                className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                placeholder="Category name"
                value={categoryNameDraft}
                onChange={e => setCategoryNameDraft(e.target.value)}
                autoFocus
                required
              />
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeCategoryModal}
                  className="flex-1 py-2 rounded border border-border"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!categoryNameDraft.trim()}
                  className="flex-1 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {categoryModal?.type === 'rename' && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onMouseDown={onModalBackdropMouseDown}
          onClick={onModalBackdropClick(closeCategoryModal)}
        >
          <div
            className="bg-card border border-border rounded-lg w-full max-w-sm p-6"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Pencil className="h-4 w-4" /> Rename Category
            </h3>
            <form onSubmit={submitRenameCategory} className="space-y-3">
              <input
                className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                placeholder="Category name"
                value={categoryNameDraft}
                onChange={e => setCategoryNameDraft(e.target.value)}
                autoFocus
                required
              />
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeCategoryModal}
                  className="flex-1 py-2 rounded border border-border"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!categoryNameDraft.trim()}
                  className="flex-1 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {categoryModal?.type === 'delete' && deleteModalCategory && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onMouseDown={onModalBackdropMouseDown}
          onClick={onModalBackdropClick(closeCategoryModal)}
        >
          <div
            className="bg-card border border-border rounded-lg w-full max-w-sm p-6"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-2 flex items-center gap-2">
              <Trash2 className="h-4 w-4" /> Delete Category
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              Delete &ldquo;{deleteModalCategory.name}&rdquo;
              {deleteAffectedCount > 0
                ? ` (${deleteAffectedCount} server${deleteAffectedCount === 1 ? '' : 's'})`
                : ''}
              ?
            </p>
            <form onSubmit={submitDeleteCategory} className="space-y-3">
              {deleteAffectedCount > 0 && (
                <>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      className="mt-1"
                      checked={categoryModal.disposition === 'move'}
                      onChange={() =>
                        setCategoryModal({
                          ...categoryModal,
                          disposition: 'move',
                        })
                      }
                    />
                    <span>
                      Move servers to another category
                      {categoryModal.disposition === 'move' && (
                        <select
                          className="mt-2 w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                          value={categoryModal.moveToCategoryId}
                          onChange={e =>
                            setCategoryModal({
                              ...categoryModal,
                              moveToCategoryId: e.target.value,
                            })
                          }
                        >
                          {deleteMoveTargets.map(c => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      className="mt-1"
                      checked={categoryModal.disposition === 'delete-servers'}
                      onChange={() =>
                        setCategoryModal({
                          ...categoryModal,
                          disposition: 'delete-servers',
                        })
                      }
                    />
                    <span>Delete the servers in this category</span>
                  </label>
                </>
              )}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeCategoryModal}
                  className="flex-1 py-2 rounded border border-border"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 rounded bg-red-600 text-white hover:bg-red-500"
                >
                  Delete
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddModal && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onMouseDown={onModalBackdropMouseDown}
          onClick={onModalBackdropClick(closeModal)}
        >
          <div
            className="bg-card border border-border rounded-lg w-full max-w-md p-6"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              {isEditing ? (
                <>
                  <Pencil className="h-4 w-4" /> Edit Server
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" /> Add Server
                </>
              )}
            </h3>
            <form onSubmit={handleSaveServer} className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">Type</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setConnectionType('terminal')}
                    className={`py-2 rounded border text-sm ${
                      newServer.connectionType === 'terminal'
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-muted-foreground'
                    }`}
                  >
                    Terminal
                  </button>
                  <button
                    type="button"
                    onClick={() => setConnectionType('file')}
                    className={`py-2 rounded border text-sm ${
                      newServer.connectionType === 'file'
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-muted-foreground'
                    }`}
                  >
                    File Transfer
                  </button>
                  <button
                    type="button"
                    onClick={() => setConnectionType('desktop')}
                    className={`py-2 rounded border text-sm ${
                      newServer.connectionType === 'desktop'
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-muted-foreground'
                    }`}
                  >
                    Desktop
                  </button>
                </div>
              </div>

              {newServer.connectionType && (
                <>
                  <input
                    className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                    placeholder="Name"
                    value={newServer.name}
                    onChange={e => setNewServer(s => ({ ...s, name: e.target.value }))}
                    required
                  />

                  {newServer.connectionType === 'terminal' && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1.5 block">
                        Connection method
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setConnectionMethod('network')}
                          className={`py-1.5 rounded border text-sm ${
                            newServer.connectionMethod === 'network'
                              ? 'border-accent bg-accent/10 text-accent'
                              : 'border-border text-muted-foreground'
                          }`}
                        >
                          Network
                        </button>
                        <button
                          type="button"
                          onClick={() => setConnectionMethod('serial')}
                          className={`py-1.5 rounded border text-sm ${
                            newServer.connectionMethod === 'serial'
                              ? 'border-accent bg-accent/10 text-accent'
                              : 'border-border text-muted-foreground'
                          }`}
                        >
                          Serial
                        </button>
                      </div>
                    </div>
                  )}

                  {isSerialMethod ? (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="col-span-2">
                          <label className="text-xs text-muted-foreground mb-1.5 block">
                            COM port
                          </label>
                          <select
                            className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                            value={newServer.serialPort}
                            onChange={e =>
                              setNewServer(s => ({ ...s, serialPort: e.target.value }))
                            }
                            required
                          >
                            <option value="">
                              {serialPortsLoading
                                ? 'Scanning ports…'
                                : serialPorts.length === 0
                                  ? 'No serial ports found'
                                  : 'Select a port…'}
                            </option>
                            {newServer.serialPort &&
                              !serialPorts.some(p => p.path === newServer.serialPort) && (
                                <option value={newServer.serialPort}>
                                  {newServer.serialPort} (not currently present)
                                </option>
                              )}
                            {serialPorts.map(p => (
                              <option key={p.path} value={p.path}>
                                {p.friendlyName
                                  ? `${p.path} — ${p.friendlyName}`
                                  : p.path}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="text-xs text-muted-foreground mb-1.5 block">
                            Baud rate
                          </label>
                          <input
                            type="number"
                            list="baud-presets"
                            className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                            value={newServer.baudRate}
                            placeholder={String(DEFAULT_SERIAL_BAUD_RATE)}
                            onChange={e => {
                              const raw = e.target.value
                              if (raw === '') {
                                setNewServer(s => ({ ...s, baudRate: '' }))
                                return
                              }
                              const parsed = parseInt(raw, 10)
                              if (Number.isFinite(parsed)) {
                                setNewServer(s => ({ ...s, baudRate: parsed }))
                              }
                            }}
                          />
                          <datalist id="baud-presets">
                            {BAUD_PRESETS.map(b => (
                              <option key={b} value={b} />
                            ))}
                          </datalist>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                        onClick={() =>
                          setNewServer(s => ({
                            ...s,
                            showSerialAdvanced: !s.showSerialAdvanced,
                          }))
                        }
                      >
                        {newServer.showSerialAdvanced ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        Advanced
                      </button>
                      {newServer.showSerialAdvanced && (
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="text-[11px] text-muted-foreground mb-1 block">
                              Data bits
                            </label>
                            <select
                              className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                              value={newServer.dataBits}
                              onChange={e =>
                                setNewServer(s => ({
                                  ...s,
                                  dataBits: Number(e.target.value) as SerialDataBits,
                                }))
                              }
                            >
                              {[5, 6, 7, 8].map(n => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-[11px] text-muted-foreground mb-1 block">
                              Parity
                            </label>
                            <select
                              className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                              value={newServer.parity}
                              onChange={e =>
                                setNewServer(s => ({
                                  ...s,
                                  parity: e.target.value as SerialParity,
                                }))
                              }
                            >
                              <option value="none">None</option>
                              <option value="even">Even</option>
                              <option value="odd">Odd</option>
                              <option value="mark">Mark</option>
                              <option value="space">Space</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-[11px] text-muted-foreground mb-1 block">
                              Stop bits
                            </label>
                            <select
                              className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                              value={String(newServer.stopBits)}
                              onChange={e =>
                                setNewServer(s => ({
                                  ...s,
                                  stopBits: Number(e.target.value) as SerialStopBits,
                                }))
                              }
                            >
                              <option value="1">1</option>
                              <option value="1.5">1.5</option>
                              <option value="2">2</option>
                            </select>
                          </div>
                        </div>
                      )}
                      <input
                        className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                        placeholder="OS, like Ubuntu 26.04"
                        value={newServer.lastKnownOs}
                        onChange={e => setNewServer(s => ({ ...s, lastKnownOs: e.target.value }))}
                        aria-label="OS Suggestion"
                      />
                    </>
                  ) : (
                    <>
                  <div className="grid grid-cols-2 gap-3">
                    {newServer.connectionType === 'terminal' ? (
                      <select
                        className="bg-background border border-border rounded px-3 py-1.5 text-sm"
                        value={newServer.protocol}
                        onChange={e => setProtocol(e.target.value as Protocol)}
                      >
                        {TERMINAL_PROTOCOLS.map(p => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    ) : newServer.connectionType === 'desktop' ? (
                      <select
                        className="bg-background border border-border rounded px-3 py-1.5 text-sm"
                        value="rdp"
                        disabled
                      >
                        <option value="rdp">RDP</option>
                      </select>
                    ) : (
                      <select
                        className="bg-background border border-border rounded px-3 py-1.5 text-sm"
                        value={newServer.protocol}
                        onChange={e => setProtocol(e.target.value as Protocol)}
                      >
                        {FILE_TRANSFER_PROTOCOLS.map(p => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <input
                      type="number"
                      className="bg-background border border-border rounded px-3 py-1.5 text-sm"
                      value={newServer.port}
                      placeholder={String(defaultPortForProtocol(newServer.protocol))}
                      onChange={e => {
                        const raw = e.target.value
                        if (raw === '') {
                          setNewServer(s => ({ ...s, port: '' }))
                          return
                        }
                        const parsed = parseInt(raw, 10)
                        if (Number.isFinite(parsed)) {
                          setNewServer(s => ({ ...s, port: parsed }))
                        }
                      }}
                    />
                  </div>
                  <input
                    className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                    placeholder="Host"
                    value={newServer.host}
                    onChange={e => setNewServer(s => ({ ...s, host: e.target.value }))}
                    required
                  />
                  <input
                    className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                    placeholder="Username"
                    value={newServer.username}
                    onChange={e => setNewServer(s => ({ ...s, username: e.target.value }))}
                  />
                  {newServer.connectionType === 'desktop' && (
                    <input
                      className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                      placeholder="Domain (optional)"
                      value={newServer.domain}
                      onChange={e => setNewServer(s => ({ ...s, domain: e.target.value }))}
                    />
                  )}
                  <input
                    className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                    placeholder="OS, like Ubuntu 26.04"
                    value={newServer.lastKnownOs}
                    onChange={e => setNewServer(s => ({ ...s, lastKnownOs: e.target.value }))}
                    aria-label="OS Suggestion"
                  />

                  {(newServer.protocol === 'ftps' || newServer.protocol === 'ftps-implicit') && (
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={newServer.allowInvalidCertificate}
                        onChange={e =>
                          setNewServer(s => ({ ...s, allowInvalidCertificate: e.target.checked }))
                        }
                      />
                      <span>
                        Allow invalid TLS certificate
                        <span className="block text-[11px] text-muted-foreground">
                          Skips certificate validation. Only enable for trusted self-signed servers.
                        </span>
                      </span>
                    </label>
                  )}
                    </>
                  )}

                  {hasCustomCategories && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1.5 block">Category</label>
                      <select
                        className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                        value={newServer.categoryId}
                        onChange={e =>
                          setNewServer(s => ({ ...s, categoryId: e.target.value }))
                        }
                      >
                        {sortedCategories.map(c => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {!isTelnetProtocol && !isSerialMethod && (
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block">
                      Authentication
                    </label>
                    {supportsKeyAuth ? (
                      <div className="grid grid-cols-2 gap-2 mb-2">
                        <button
                          type="button"
                          onClick={() =>
                            setNewServer(s => ({ ...s, authMethod: 'password', keyId: '' }))
                          }
                          className={`py-1.5 rounded border text-sm ${
                            newServer.authMethod === 'password'
                              ? 'border-accent bg-accent/10 text-accent'
                              : 'border-border text-muted-foreground'
                          }`}
                        >
                          Password
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setNewServer(s => ({ ...s, authMethod: 'privateKey', password: '' }))
                          }
                          className={`py-1.5 rounded border text-sm ${
                            newServer.authMethod === 'privateKey'
                              ? 'border-accent bg-accent/10 text-accent'
                              : 'border-border text-muted-foreground'
                          }`}
                        >
                          SSH Key
                        </button>
                      </div>
                    ) : null}

                    {!supportsKeyAuth || newServer.authMethod === 'password' ? (
                      <input
                        type="password"
                        className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                        placeholder="Password"
                        value={newServer.password}
                        onChange={e => setNewServer(s => ({ ...s, password: e.target.value }))}
                      />
                    ) : (
                      <div className="space-y-2">
                        {authKeys.length === 0 ? (
                          <div className="text-xs text-muted-foreground border border-dashed border-border rounded p-3">
                            No keys saved yet.{' '}
                            <button
                              type="button"
                              onClick={() => {
                                closeModal()
                                onOpenAuthSettings()
                              }}
                              className="text-accent hover:underline inline-flex items-center gap-1"
                            >
                              <KeyRound className="h-3 w-3" />
                              Add a key in Settings
                            </button>
                          </div>
                        ) : (
                          <select
                            className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                            value={newServer.keyId}
                            onChange={e => setNewServer(s => ({ ...s, keyId: e.target.value }))}
                            required
                          >
                            <option value="">Select a key…</option>
                            {authKeys.map(key => (
                              <option key={key.id} value={key.id}>
                                {key.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                  )}
                </>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 py-2 rounded border border-border"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="flex-1 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
                >
                  {isEditing ? 'Save' : 'Add'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default ServerSidebar
