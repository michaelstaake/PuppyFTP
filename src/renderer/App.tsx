import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { FC } from 'react'
import {
  Server,
  Category,
  AppSettings,
  SettingsSection,
  ThemePreference,
  AICommandApprovalRequest,
  AISession,
  AIChatMessage,
  ConnectionStatus,
  DEFAULT_CONNECTION_TIMEOUT,
  DEFAULT_CATEGORIES,
  DEFAULT_CONTEXT_LENGTH,
  UNCATEGORIZED_ID,
  normalizeConnectionTimeout,
} from '@shared/types'
import ServerSidebar from './components/servers/ServerSidebar'
import TopBar from './components/layout/TopBar'
import MainArea from './components/layout/MainArea'
import SettingsPage from './components/settings/SettingsPage'
import TransfersPage from './components/transfers/TransfersPage'
import AIChatPanel from './components/ai/AIChatPanel'
import { applyResolvedTheme, normalizeThemePreference, resolveTheme } from './lib/theme'
import { estimateMessagesTokens } from './lib/aiContext'
import { useTransferStore } from './store/transferStore'
import type { TransferProgressEvent } from '@shared/types'

const defaultSettings: AppSettings = {
  theme: 'system',
  connectionTimeout: DEFAULT_CONNECTION_TIMEOUT,
  protectServerData: false,
  ai: {
    enabled: true,
    baseURL: '',
    model: '',
    apiKey: '',
    allowRunCommands: false,
    askBeforeRunningCommands: true,
    contextLength: DEFAULT_CONTEXT_LENGTH,
  },
  keys: [],
}

function newSessionId(): string {
  return `ais_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function createAISession(serverId: string): AISession {
  const now = Date.now()
  return {
    id: newSessionId(),
    serverId,
    title: 'New chat',
    messages: [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
}

function titleFromQuery(query: string): string {
  const t = query.trim().replace(/\s+/g, ' ')
  if (!t) return 'New chat'
  return t.length > 60 ? `${t.slice(0, 57)}…` : t
}

const App: FC = () => {
  const [servers, setServers] = useState<Server[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  /** Per-server session status. Absent = disconnected. */
  const [connectionByServerId, setConnectionByServerId] = useState<
    Record<string, Exclude<ConnectionStatus, 'disconnected'>>
  >({})
  /** Bumped on reconnect so terminal/explorer remount cleanly. */
  const [sessionGenerationByServerId, setSessionGenerationByServerId] = useState<
    Record<string, number>
  >({})
  /** SSH terminals currently shown in a separate BrowserWindow. */
  const [poppedOutByServerId, setPoppedOutByServerId] = useState<Record<string, boolean>>({})
  /** Session ids to re-attach after docking a pop-out back into the main window. */
  const [attachSessionIdByServerId, setAttachSessionIdByServerId] = useState<Record<string, string>>(
    {}
  )
  const [isLoading, setIsLoading] = useState(true)
  const [aiChatOpen, setAiChatOpen] = useState(false)
  const [aiSessions, setAiSessions] = useState<AISession[]>([])
  /** Active (writable) session id per server for this app run. */
  const [activeSessionIdByServer, setActiveSessionIdByServer] = useState<Record<string, string>>({})
  /** Session currently shown in the panel. */
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null)
  const [aiStreaming, setAiStreaming] = useState(false)
  const [pendingCommandApproval, setPendingCommandApproval] = useState<AICommandApprovalRequest | null>(null)
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: "success" | "error" | "info" }>>([])
  const aiAssistantIdRef = useRef<string | null>(null)
  const aiSessionsRef = useRef<AISession[]>([])
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewingSessionIdRef = useRef<string | null>(null)
  /** Bumps on new chat / cancel so in-flight askAI cannot leave streaming stuck. */
  const aiAskGenRef = useRef(0)
  const toastIdRef = useRef(0)

  const showToast = (message: string, type: "success" | "error" | "info" = "info") => {
    const id = ++toastIdRef.current
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3200)
  }

  const [showAddModal, setShowAddModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showTransfers, setShowTransfers] = useState(false)
  const applyTransferProgress = useTransferStore(s => s.applyProgress)
  const hydrateTransfers = useTransferStore(s => s.hydrate)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)

  const selectedServer = servers.find(s => s.id === selectedServerId) || null
  const sessionStatuses: Array<Exclude<ConnectionStatus, 'disconnected'>> = [
    'connecting',
    'connected',
    'lost',
    'failed',
  ]
  const connectedServers = servers.filter(s => {
    const status = connectionByServerId[s.id]
    return status != null && sessionStatuses.includes(status)
  })
  const selectedConnectionStatus: ConnectionStatus = selectedServerId
    ? connectionByServerId[selectedServerId] ?? 'disconnected'
    : 'disconnected'
  const isSelectedConnected = selectedConnectionStatus === 'connected'
  const isSelectedConnecting = selectedConnectionStatus === 'connecting'
  const isSelectedConnectionLost = selectedConnectionStatus === 'lost'
  const isSelectedConnectionFailed = selectedConnectionStatus === 'failed'

  useEffect(() => {
    aiSessionsRef.current = aiSessions
  }, [aiSessions])

  useEffect(() => {
    viewingSessionIdRef.current = viewingSessionId
  }, [viewingSessionId])

  useEffect(() => {
    if (!window.electronAPI?.onTransferProgress) return
    return window.electronAPI.onTransferProgress((data: TransferProgressEvent) => {
      if (!data?.transferId) return
      applyTransferProgress(data)
    })
  }, [applyTransferProgress])

  const persistSessions = useCallback((sessions: AISession[]) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      void window.electronAPI?.saveAISessions?.({ sessions })
    }, 200)
  }, [])

  const aiSessionsHydratedRef = useRef(false)

  const replaceSessions = useCallback((updater: (prev: AISession[]) => AISession[]) => {
    // Ref is source of truth for sync readers (ensureActiveSession / new chat).
    // Avoid side effects inside setState updaters — Strict Mode may double-invoke them.
    const next = updater(aiSessionsRef.current)
    aiSessionsRef.current = next
    setAiSessions(next)
  }, [])

  // Persist after hydration only — never write the initial empty [] over disk.
  useEffect(() => {
    if (!aiSessionsHydratedRef.current) return
    persistSessions(aiSessions)
  }, [aiSessions, persistSessions])

  const updateSessionById = useCallback(
    (sessionId: string, patch: (session: AISession) => AISession) => {
      replaceSessions(prev => prev.map(s => (s.id === sessionId ? patch(s) : s)))
    },
    [replaceSessions]
  )

  const connectSelectedServer = () => {
    if (!selectedServerId) return
    setConnectionByServerId(prev => {
      if (prev[selectedServerId] === 'connected' || prev[selectedServerId] === 'connecting') {
        return prev
      }
      return { ...prev, [selectedServerId]: 'connecting' }
    })
  }

  const markConnectionEstablished = useCallback((id: string) => {
    setConnectionByServerId(prev => {
      if (prev[id] !== 'connecting' && prev[id] !== 'connected') return prev
      if (prev[id] === 'connected') return prev
      return { ...prev, [id]: 'connected' }
    })
  }, [])

  const markConnectionFailed = useCallback((id: string) => {
    setConnectionByServerId(prev => {
      if (prev[id] !== 'connecting') return prev
      return { ...prev, [id]: 'failed' }
    })
    void window.electronAPI?.disconnectRemote?.(id).catch(() => {})
  }, [])

  const markConnectionLost = useCallback((id: string) => {
    setConnectionByServerId(prev => {
      if (prev[id] === 'connecting') return { ...prev, [id]: 'failed' }
      if (prev[id] !== 'connected') return prev
      return { ...prev, [id]: 'lost' }
    })
    void window.electronAPI?.disconnectRemote?.(id).catch(() => {})
  }, [])

  const disconnectServer = async (id: string) => {
    setConnectionByServerId(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setPoppedOutByServerId(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setAttachSessionIdByServerId(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      await window.electronAPI?.closeTerminalForServer?.(id)
    } catch (e) {
      console.warn('close terminal failed', e)
    }
    try {
      await window.electronAPI?.closeRdpForServer?.(id)
    } catch (e) {
      console.warn('close rdp failed', e)
    }
    try {
      await window.electronAPI?.disconnectRemote?.(id)
    } catch (e) {
      console.warn('disconnect failed', e)
    }
  }

  const disconnectSelectedServer = () => {
    if (selectedServerId) void disconnectServer(selectedServerId)
  }

  const clearAttachSessionId = useCallback((id: string) => {
    setAttachSessionIdByServerId(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const reconnectSelectedServer = () => {
    if (!selectedServerId) return
    const id = selectedServerId
    void (async () => {
      try {
        await window.electronAPI?.closeTerminalForServer?.(id)
      } catch {
        /* ignore */
      }
      try {
        await window.electronAPI?.closeRdpForServer?.(id)
      } catch {
        /* ignore */
      }
      try {
        await window.electronAPI?.disconnectRemote?.(id)
      } catch {
        /* ignore */
      }
      setPoppedOutByServerId(prev => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      setAttachSessionIdByServerId(prev => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      // Stay in failed/lost during cleanup so late close events don't race a fresh attempt.
      setSessionGenerationByServerId(prev => ({
        ...prev,
        [id]: (prev[id] || 0) + 1,
      }))
      setConnectionByServerId(prev => ({ ...prev, [id]: 'connecting' }))
    })()
  }

  useEffect(() => {
    let cancelled = false
    const loadData = async () => {
      try {
        if (window.electronAPI) {
          const [s, c, settings, sessionStore, transferStore] = await Promise.all([
            window.electronAPI.getServers(),
            window.electronAPI.getCategories(),
            window.electronAPI.getSettings(),
            window.electronAPI.getAISessions?.() ?? Promise.resolve({ sessions: [] }),
            window.electronAPI.getTransferHistory?.() ?? Promise.resolve({ transfers: [] }),
          ])
          if (cancelled) return
          setServers(s || [])
          setCategories(c?.length ? c : DEFAULT_CATEGORIES)
          const next: AppSettings = {
            ...defaultSettings,
            ...settings,
            theme: normalizeThemePreference(settings?.theme),
            connectionTimeout: normalizeConnectionTimeout(settings?.connectionTimeout),
            protectServerData: settings?.protectServerData === true,
            ai: { ...defaultSettings.ai, ...settings?.ai },
            keys: settings?.keys || [],
          }
          setAppSettings(next)
          const sessions = sessionStore?.sessions || []
          aiSessionsRef.current = sessions
          aiSessionsHydratedRef.current = true
          setAiSessions(sessions)
          hydrateTransfers(transferStore || { transfers: [] })
          applyResolvedTheme(await resolveTheme(next.theme))
        } else {
          if (cancelled) return
          setServers([])
          setCategories([...DEFAULT_CATEGORIES])
          setAppSettings(defaultSettings)
          aiSessionsRef.current = []
          aiSessionsHydratedRef.current = true
          setAiSessions([])
          hydrateTransfers({ transfers: [] })
          applyResolvedTheme(await resolveTheme(defaultSettings.theme))
        }
      } catch (e) {
        if (cancelled) return
        console.error('load failed', e)
        setAppSettings(defaultSettings)
        aiSessionsHydratedRef.current = true
        applyResolvedTheme(await resolveTheme(defaultSettings.theme))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadData()
    return () => {
      cancelled = true
    }
  }, [hydrateTransfers])

  // End AI sessions when the app process is quitting (tray Quit / last window)
  useEffect(() => {
    const endSessions = () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      const now = Date.now()
      const ended = aiSessionsRef.current.map(s =>
        s.status === 'active'
          ? { ...s, status: 'ended' as const, endedAt: now, updatedAt: now }
          : s
      )
      aiSessionsRef.current = ended
      void window.electronAPI?.saveAISessions?.({ sessions: ended })
      void window.electronAPI?.endActiveAISessions?.()
    }

    window.addEventListener('beforeunload', endSessions)
    return () => {
      window.removeEventListener('beforeunload', endSessions)
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!appSettings) return

    let cancelled = false

    const syncTheme = async () => {
      const resolved = await resolveTheme(appSettings.theme)
      if (!cancelled) applyResolvedTheme(resolved)
    }

    void syncTheme()

    if (appSettings.theme !== 'system') return

    const unsub = window.electronAPI?.onSystemThemeChange?.(resolved => {
      applyResolvedTheme(resolved)
    })

    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onMediaChange = () => {
      void syncTheme()
    }
    media?.addEventListener('change', onMediaChange)

    return () => {
      cancelled = true
      unsub?.()
      media?.removeEventListener('change', onMediaChange)
    }
  }, [appSettings?.theme]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateServers = async (newServers: Server[]) => {
    setServers(newServers)
    if (window.electronAPI) await window.electronAPI.saveServers(newServers)
  }

  const handleLocalPathChange = useCallback((serverId: string, path: string) => {
    setServers(prev => {
      const current = prev.find(s => s.id === serverId)
      if (!current || current.lastLocalPath === path) return prev
      const updated = prev.map(s => (s.id === serverId ? { ...s, lastLocalPath: path } : s))
      void window.electronAPI?.saveServers(updated)
      return updated
    })
  }, [])

  const updateCategories = async (newCategories: Category[]) => {
    setCategories(newCategories)
    if (window.electronAPI) await window.electronAPI.saveCategories(newCategories)
  }

  const addServer = async (serverData: Omit<Server, 'id' | 'createdAt' | 'order'>) => {
    const newServer: Server = {
      ...serverData,
      id: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11),
      createdAt: Date.now(),
      order: servers.length,
      categoryId: serverData.categoryId || UNCATEGORIZED_ID,
    }
    await updateServers([...servers, newServer])
    setSelectedServerId(newServer.id)
    setShowAddModal(false)
    showToast(`Added server "${newServer.name}"`, "success")
  }

  const removeServersByIds = async (ids: string[]) => {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    for (const id of ids) {
      await disconnectServer(id)
    }
    const updated = servers.filter(s => !idSet.has(s.id))
    await updateServers(updated)
    replaceSessions(prev => prev.filter(s => !idSet.has(s.serverId)))
    setActiveSessionIdByServer(prev => {
      const next = { ...prev }
      for (const id of ids) delete next[id]
      return next
    })
    if (selectedServerId && idSet.has(selectedServerId)) {
      setAiChatOpen(false)
      setViewingSessionId(null)
      setSelectedServerId(updated[0]?.id ?? null)
    }
    for (const id of ids) {
      void window.electronAPI?.deleteAISessionsForServer?.(id)
    }
  }

  const deleteServer = async (id: string) => {
    await removeServersByIds([id])
    showToast('Server removed', 'info')
  }

  const deleteServers = async (ids: string[]) => {
    await removeServersByIds(ids)
    showToast(ids.length === 1 ? 'Server removed' : `${ids.length} servers removed`, 'info')
  }

  const selectServer = (id: string) => {
    setShowSettings(false)
    setShowTransfers(false)
    // Hide Ask AI when switching servers; session stays active for reopen
    setAiChatOpen(false)
    setPendingCommandApproval(null)

    // Abandoned connect attempts shouldn't stick as failed/connecting when leaving the server.
    if (selectedServerId && selectedServerId !== id) {
      const leavingId = selectedServerId
      setConnectionByServerId(prev => {
        const status = prev[leavingId]
        if (status !== 'failed' && status !== 'connecting') return prev
        const next = { ...prev }
        delete next[leavingId]
        void window.electronAPI?.disconnectRemote?.(leavingId).catch(() => {})
        return next
      })
    }

    setSelectedServerId(id)
  }

  const aiEnabled = appSettings?.ai.enabled !== false
  const contextLength = appSettings?.ai.contextLength || DEFAULT_CONTEXT_LENGTH

  const viewingSession = useMemo(
    () => aiSessions.find(s => s.id === viewingSessionId) || null,
    [aiSessions, viewingSessionId]
  )

  const serverSessions = useMemo(
    () => (selectedServerId ? aiSessions.filter(s => s.serverId === selectedServerId) : []),
    [aiSessions, selectedServerId]
  )

  const aiMessages = viewingSession?.messages ?? []
  const sessionReadOnly = viewingSession?.status === 'ended'
  const contextUsed = estimateMessagesTokens(aiMessages)

  const ensureActiveSession = useCallback(
    (serverId: string): AISession => {
      const mappedId = activeSessionIdByServer[serverId]
      const mapped = mappedId
        ? aiSessionsRef.current.find(s => s.id === mappedId && s.serverId === serverId && s.status === 'active')
        : undefined
      if (mapped) {
        setViewingSessionId(mapped.id)
        return mapped
      }

      const existingActive = aiSessionsRef.current.find(
        s => s.serverId === serverId && s.status === 'active'
      )
      if (existingActive) {
        setActiveSessionIdByServer(prev => ({ ...prev, [serverId]: existingActive.id }))
        setViewingSessionId(existingActive.id)
        return existingActive
      }

      const session = createAISession(serverId)
      replaceSessions(prev => [...prev, session])
      setActiveSessionIdByServer(prev => ({ ...prev, [serverId]: session.id }))
      setViewingSessionId(session.id)
      return session
    },
    [activeSessionIdByServer, replaceSessions]
  )

  const toggleAIChat = () => {
    if (!selectedServerId || !aiEnabled) return
    if (aiChatOpen) {
      setAiChatOpen(false)
      return
    }
    ensureActiveSession(selectedServerId)
    setAiChatOpen(true)
  }

  const invalidateAiAsk = useCallback(() => {
    aiAskGenRef.current += 1
    aiAssistantIdRef.current = null
    setAiStreaming(false)
    setPendingCommandApproval(null)
  }, [])

  const handleNewSession = () => {
    if (!selectedServerId) return

    invalidateAiAsk()

    const current = viewingSessionId
      ? aiSessionsRef.current.find(s => s.id === viewingSessionId)
      : null
    // Already on a blank active chat — keep it writable instead of ending it.
    if (
      current &&
      current.serverId === selectedServerId &&
      current.status === 'active' &&
      current.messages.length === 0
    ) {
      setActiveSessionIdByServer(p => ({ ...p, [selectedServerId]: current.id }))
      setViewingSessionId(current.id)
      setAiChatOpen(true)
      return
    }

    const now = Date.now()
    const session = createAISession(selectedServerId)
    replaceSessions(prev => [
      ...prev.map(s =>
        s.serverId === selectedServerId && s.status === 'active'
          ? { ...s, status: 'ended' as const, endedAt: now, updatedAt: now }
          : s
      ),
      session,
    ])
    setActiveSessionIdByServer(p => ({ ...p, [selectedServerId]: session.id }))
    setViewingSessionId(session.id)
    setAiChatOpen(true)
  }

  const handleSelectSession = (sessionId: string) => {
    const session = aiSessionsRef.current.find(s => s.id === sessionId)
    if (!session || session.serverId !== selectedServerId) return
    setViewingSessionId(sessionId)
    if (session.status === 'active') {
      setActiveSessionIdByServer(prev => ({ ...prev, [session.serverId]: sessionId }))
    } else {
      // Browsing history — don't leave a stuck streaming lock on the composer.
      setAiStreaming(false)
      setPendingCommandApproval(null)
    }
    setAiChatOpen(true)
  }

  // Recover if the viewed session disappeared (e.g. stale id after reload).
  useEffect(() => {
    if (!aiChatOpen || !selectedServerId) return
    if (viewingSessionId && aiSessionsRef.current.some(s => s.id === viewingSessionId)) return
    ensureActiveSession(selectedServerId)
  }, [aiChatOpen, selectedServerId, viewingSessionId, aiSessions, ensureActiveSession])

  const updateAssistantMessage = (sessionId: string, id: string, content: string) => {
    updateSessionById(sessionId, session => ({
      ...session,
      updatedAt: Date.now(),
      messages: session.messages.map(m => (m.id === id ? { ...m, content } : m)),
    }))
  }

  const respondCommandApproval = (requestId: string, approved: boolean) => {
    setPendingCommandApproval(prev => (prev?.requestId === requestId ? null : prev))
    void window.electronAPI?.respondAICommandApproval?.(requestId, approved)
  }

  useEffect(() => {
    if (!window.electronAPI?.onAICommandApproval) return
    const unsubApproval = window.electronAPI.onAICommandApproval(request => {
      setAiChatOpen(true)
      setPendingCommandApproval(request)
    })
    const unsubStatus = window.electronAPI.onAICommandStatus?.(status => {
      const sessionId = viewingSessionIdRef.current
      if (!sessionId) return
      updateSessionById(sessionId, session => {
        if (session.status !== 'active') return session
        const statusMsg: AIChatMessage = {
          id: `cmd-${status.phase}-${Date.now()}`,
          role: 'system',
          kind: 'command-status',
          commandPhase: status.phase,
          content:
            status.phase === 'error' && status.detail
              ? `${status.command}\n${status.detail}`
              : status.command,
        }

        const prev = session.messages
        if (status.phase !== 'running') {
          const idx = [...prev].reverse().findIndex(
            m => m.kind === 'command-status' && m.commandPhase === 'running' && m.content === status.command
          )
          if (idx >= 0) {
            const realIdx = prev.length - 1 - idx
            const next = [...prev]
            next[realIdx] = {
              ...next[realIdx],
              commandPhase: status.phase,
              content: statusMsg.content,
            }
            return { ...session, updatedAt: Date.now(), messages: next }
          }
        }

        const last = prev[prev.length - 1]
        if (
          last?.role === 'assistant' &&
          last.content === '' &&
          aiAssistantIdRef.current === last.id
        ) {
          return {
            ...session,
            updatedAt: Date.now(),
            messages: [...prev.slice(0, -1), statusMsg, last],
          }
        }
        return { ...session, updatedAt: Date.now(), messages: [...prev, statusMsg] }
      })
    })
    return () => {
      unsubApproval?.()
      unsubStatus?.()
    }
  }, [updateSessionById])

  useEffect(() => {
    const unsub = window.electronAPI?.onRemoteConnectionLost?.(serverId => {
      markConnectionLost(serverId)
    })
    return () => {
      unsub?.()
    }
  }, [markConnectionLost])

  useEffect(() => {
    const unsub = window.electronAPI?.onTerminalPopoutState?.(state => {
      if (!state?.serverId) return
      const { serverId, poppedOut, sessionId, ended, disconnect } = state

      if (poppedOut) {
        setPoppedOutByServerId(prev => ({ ...prev, [serverId]: true }))
        setAttachSessionIdByServerId(prev => {
          if (!(serverId in prev)) return prev
          const next = { ...prev }
          delete next[serverId]
          return next
        })
        return
      }

      setPoppedOutByServerId(prev => {
        if (!(serverId in prev)) return prev
        const next = { ...prev }
        delete next[serverId]
        return next
      })

      if (disconnect || ended) {
        setAttachSessionIdByServerId(prev => {
          if (!(serverId in prev)) return prev
          const next = { ...prev }
          delete next[serverId]
          return next
        })
        if (disconnect) {
          // Same as clicking Disconnect — return to the idle "Not connected" state.
          setConnectionByServerId(prev => {
            if (!(serverId in prev)) return prev
            const next = { ...prev }
            delete next[serverId]
            return next
          })
        } else {
          markConnectionLost(serverId)
        }
        return
      }

      if (sessionId) {
        setAttachSessionIdByServerId(prev => ({ ...prev, [serverId]: sessionId }))
      }
    })
    return () => {
      unsub?.()
    }
  }, [markConnectionLost])

  const handleAskAI = async (query: string) => {
    if (!selectedServer || !aiEnabled || !appSettings?.ai || aiStreaming || pendingCommandApproval) return
    const session = ensureActiveSession(selectedServer.id)
    if (session.status !== 'active') return

    const sessionId = session.id
    const askGen = ++aiAskGenRef.current
    const ai = appSettings.ai

    const userId = `u-${Date.now()}`
    const assistantId = `a-${Date.now()}`
    aiAssistantIdRef.current = assistantId
    setAiChatOpen(true)
    setViewingSessionId(sessionId)

    const priorHistory = session.messages
      .filter(
        m =>
          m.kind !== 'command-status' &&
          (m.role === 'user' || m.role === 'assistant') &&
          m.content.trim()
      )
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    let earlyError: string | null = null
    if (!ai.baseURL?.trim()) {
      earlyError = 'No base URL. Configure in Settings > AI'
    } else if (!ai.model?.trim()) {
      earlyError = 'No model. Configure in Settings > AI'
    } else if (!window.electronAPI?.askAI) {
      earlyError = 'AI bridge unavailable. Restart PuppyFTP.'
    }

    updateSessionById(sessionId, s => ({
      ...s,
      title: s.messages.length === 0 ? titleFromQuery(query) : s.title,
      updatedAt: Date.now(),
      messages: [
        ...s.messages,
        { id: userId, role: 'user', content: query },
        { id: assistantId, role: 'assistant', content: earlyError ?? '' },
      ],
    }))

    if (earlyError) {
      aiAssistantIdRef.current = null
      return
    }

    setAiStreaming(true)

    let assembled = ''
    const unsubChunk = window.electronAPI.onAIChunk?.(chunk => {
      if (aiAskGenRef.current !== askGen) return
      assembled += chunk
      updateAssistantMessage(sessionId, assistantId, assembled)
    })
    const unsubDone = window.electronAPI.onAIDone?.(full => {
      if (aiAskGenRef.current !== askGen) return
      assembled = full || assembled
      updateAssistantMessage(sessionId, assistantId, assembled)
    })
    const unsubError = window.electronAPI.onAIError?.(error => {
      if (aiAskGenRef.current !== askGen) return
      updateAssistantMessage(
        sessionId,
        assistantId,
        error.startsWith('AI ') ? error : `AI error: ${error}`
      )
    })

    try {
      const result = await window.electronAPI.askAI(
        query,
        {
          serverId: selectedServer.id,
          includeCache: true,
          connectionStatus: selectedConnectionStatus,
        },
        priorHistory
      )
      if (aiAskGenRef.current !== askGen) return
      if (result?.success) {
        const text = result.response || assembled || 'No response'
        updateAssistantMessage(sessionId, assistantId, text)
      } else {
        const err = result?.error || 'unknown'
        updateAssistantMessage(
          sessionId,
          assistantId,
          err.startsWith('AI ') || err.includes('Settings') ? err : `AI error: ${err}`
        )
      }
    } catch (e: unknown) {
      if (aiAskGenRef.current !== askGen) return
      const message = e instanceof Error ? e.message : 'unknown'
      updateAssistantMessage(sessionId, assistantId, `AI error: ${message}`)
    } finally {
      unsubChunk?.()
      unsubDone?.()
      unsubError?.()
      if (aiAskGenRef.current === askGen) {
        setAiStreaming(false)
        aiAssistantIdRef.current = null
      }
    }
  }

  const openSettings = (section: SettingsSection = 'general') => {
    setSettingsSection(section)
    setShowSettings(true)
    setShowTransfers(false)
    setAiChatOpen(false)
  }

  const openTransfers = () => {
    setShowTransfers(true)
    setShowSettings(false)
    setAiChatOpen(false)
  }

  const saveSettings = async (newSettings: AppSettings) => {
    const next = {
      ...newSettings,
      theme: normalizeThemePreference(newSettings.theme) as ThemePreference,
      connectionTimeout: normalizeConnectionTimeout(newSettings.connectionTimeout),
      ai: {
        ...defaultSettings.ai,
        ...newSettings.ai,
        contextLength: Math.max(
          1024,
          Math.min(1_000_000, Math.round(Number(newSettings.ai.contextLength) || DEFAULT_CONTEXT_LENGTH))
        ),
      },
    }
    if (window.electronAPI) {
      await window.electronAPI.saveSettings(next)
    }
    setAppSettings(next)
    applyResolvedTheme(await resolveTheme(next.theme))
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-foreground">
        Loading PuppyFTP...
      </div>
    )
  }

  return (
    <div className="app-container text-sm">
      <TopBar
        onOpenSettings={() => openSettings('general')}
        onOpenTransfers={openTransfers}
      />
      <div className="flex flex-1 overflow-hidden">
        <ServerSidebar
          servers={servers}
          categories={categories}
          selectedServerId={showSettings || showTransfers ? null : selectedServerId}
          connectionByServerId={connectionByServerId}
          onSelectServer={selectServer}
          onAddServer={addServer}
          onDeleteServer={deleteServer}
          onDeleteServers={deleteServers}
          onUpdateServers={updateServers}
          onUpdateCategories={updateCategories}
          showAddModal={showAddModal}
          setShowAddModal={setShowAddModal}
          authKeys={appSettings?.keys || []}
          onOpenAuthSettings={() => openSettings('auth')}
        />
        <div className="flex-1 flex flex-col overflow-hidden border-l border-border relative">
          {/* Keep MainArea mounted so FTP cwd / terminal sessions survive Settings & Transfers */}
          <div
            className={
              showTransfers || showSettings
                ? 'hidden'
                : 'flex-1 flex flex-col overflow-hidden min-h-0'
            }
          >
            <MainArea
              server={selectedServer}
              connectedServers={connectedServers}
              isConnected={isSelectedConnected}
              isConnecting={isSelectedConnecting}
              isConnectionLost={isSelectedConnectionLost}
              isConnectionFailed={isSelectedConnectionFailed}
              sessionGenerationByServerId={sessionGenerationByServerId}
              poppedOutByServerId={poppedOutByServerId}
              attachSessionIdByServerId={attachSessionIdByServerId}
              onConnect={connectSelectedServer}
              onDisconnect={disconnectSelectedServer}
              onReconnect={reconnectSelectedServer}
              onPopOutError={message => showToast(message, 'error')}
              onAttachConsumed={clearAttachSessionId}
              onSessionConnected={markConnectionEstablished}
              onSessionFailed={markConnectionFailed}
              onSessionClosed={markConnectionLost}
              onSessionEnded={id => void disconnectServer(id)}
              onLocalPathChange={handleLocalPathChange}
              aiEnabled={aiEnabled}
              aiChatOpen={aiChatOpen}
              onToggleAIChat={toggleAIChat}
            />
            {aiEnabled && selectedServer && (
              <AIChatPanel
                open={aiChatOpen}
                onClose={() => setAiChatOpen(false)}
                messages={aiMessages}
                streaming={aiStreaming && !sessionReadOnly}
                onSend={handleAskAI}
                serverName={selectedServer.name}
                pendingApproval={pendingCommandApproval}
                onRespondApproval={respondCommandApproval}
                sessions={serverSessions}
                currentSessionId={viewingSessionId}
                onSelectSession={handleSelectSession}
                onNewSession={handleNewSession}
                readOnly={sessionReadOnly}
                contextUsed={contextUsed}
                contextLength={contextLength}
              />
            )}
          </div>
          {showTransfers && (
            <TransfersPage servers={servers} onBack={() => setShowTransfers(false)} />
          )}
          {showSettings && appSettings && (
            <SettingsPage
              key={settingsSection}
              settings={appSettings}
              initialSection={settingsSection}
              onSave={saveSettings}
              onBack={() => setShowSettings(false)}
              onServersCleared={() => setServers([])}
            />
          )}
        </div>
      </div>
      {/* Toast notifications (Phase 6) */}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
        {toasts.map((t: {id: number; message: string; type: string}) => (
          <div
            key={t.id}
            className={`px-4 py-2 rounded-md shadow-lg text-sm font-medium text-white ${t.type === "error" ? "bg-red-600" : t.type === "success" ? "bg-emerald-600" : "bg-zinc-800 border border-border"}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
