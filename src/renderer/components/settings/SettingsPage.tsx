import React, { useEffect, useRef, useState } from 'react'
import {
  AppInfo,
  AppSettings,
  AuthKey,
  SettingsSection,
  ThemePreference,
  DEFAULT_CONNECTION_TIMEOUT,
  DEFAULT_CONTEXT_LENGTH,
  normalizeConnectionTimeout,
} from '@shared/types'
import {
  ArrowLeft,
  Bot,
  KeyRound,
  Monitor,
  Moon,
  Plus,
  Settings2,
  ShieldAlert,
  Sun,
  Trash2,
  FolderOpen,
} from 'lucide-react'

interface SettingsPageProps {
  settings: AppSettings
  initialSection?: SettingsSection
  onSave: (settings: AppSettings) => Promise<void>
  onBack: () => void
  /** Called after the "protect server data" toggle is turned off, since disabling it wipes saved servers. */
  onServersCleared?: () => void
}

const THEME_OPTIONS: { id: ThemePreference; label: string; icon: React.ReactNode }[] = [
  { id: 'system', label: 'System', icon: <Monitor className="h-4 w-4" /> },
  { id: 'light', label: 'Light', icon: <Sun className="h-4 w-4" /> },
  { id: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" /> },
]

const BASE_URL_PRESETS: { name: string; url: string }[] = [
  { name: 'LM Studio (localhost)', url: 'http://localhost:1234/v1' },
  { name: 'LmPanel (localhost)', url: 'https://localhost:8444/v1' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { name: 'xAI/SpaceXAI', url: 'https://api.x.ai/v1' },
  { name: 'Anthropic', url: 'https://api.anthropic.com/v1' },
  { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
]

/** Slash-command mode: leading `/` only, no other `/` in the value (avoids URLs and org/model ids). */
function isSlashCommandMode(value: string | undefined | null): boolean {
  if (!value) return false
  return value.startsWith('/') && !value.slice(1).includes('/')
}

function slashFilterQuery(value: string): string {
  return value.slice(1).trim().toLowerCase()
}

function formatBuildDate(isoDate: string): string {
  const parsed = new Date(isoDate.includes('T') ? isoDate : `${isoDate}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return isoDate
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

const SettingsPage: React.FC<SettingsPageProps> = ({
  settings: initialSettings,
  initialSection = 'general',
  onSave,
  onBack,
  onServersCleared,
}) => {
  const [settings, setSettings] = useState<AppSettings>(initialSettings)
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [savedFlash, setSavedFlash] = useState(false)
  const [protectConfirm, setProtectConfirm] = useState<'enable' | 'disable' | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyPath, setNewKeyPath] = useState('')
  const [newKeyPassphrase, setNewKeyPassphrase] = useState('')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelsOk, setModelsOk] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [baseUrlFocused, setBaseUrlFocused] = useState(false)
  const [modelFocused, setModelFocused] = useState(false)
  const generalRef = useRef<HTMLDivElement>(null)
  const aiRef = useRef<HTMLDivElement>(null)
  const authRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef(settings)
  const lastSavedRef = useRef(initialSettings)
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const modelsQueryRef = useRef(0)
  const modelsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sectionRef = (id: SettingsSection) => {
    if (id === 'general') return generalRef.current
    if (id === 'auth') return authRef.current
    return aiRef.current
  }

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    setSettings(initialSettings)
    lastSavedRef.current = initialSettings
  }, [initialSettings])

  useEffect(() => {
    setSection(initialSection)
    sectionRef(initialSection)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [initialSection])

  useEffect(() => {
    let cancelled = false
    const loadInfo = async () => {
      if (!window.electronAPI?.getAppInfo) {
        setAppInfo({ version: '1.0.1', buildDate: new Date().toISOString().slice(0, 10) })
        return
      }
      try {
        const info = await window.electronAPI.getAppInfo()
        if (!cancelled) setAppInfo(info)
      } catch {
        if (!cancelled) {
          setAppInfo({ version: '1.0.1', buildDate: new Date().toISOString().slice(0, 10) })
        }
      }
    }
    void loadInfo()
    return () => {
      cancelled = true
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
      if (modelsDebounceRef.current) clearTimeout(modelsDebounceRef.current)
    }
  }, [])

  const persist = async (next: AppSettings) => {
    setSettings(next)
    settingsRef.current = next
    await onSave(next)
    lastSavedRef.current = next
    setSavedFlash(true)
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current)
    flashTimeoutRef.current = setTimeout(() => setSavedFlash(false), 1500)
  }

  const aiFieldsEqual = (a: AppSettings['ai'], b: AppSettings['ai']) =>
    a.baseURL === b.baseURL && a.model === b.model && a.apiKey === b.apiKey

  const persistCurrentIfAiChanged = async () => {
    const current = settingsRef.current
    if (aiFieldsEqual(current.ai, lastSavedRef.current.ai)) return
    await persist(current)
  }

  const queryModels = async (baseURL: string, apiKey: string) => {
    const trimmed = baseURL.trim()
    if (!trimmed || isSlashCommandMode(trimmed)) {
      setAvailableModels([])
      setModelsOk(false)
      setModelsError('')
      return
    }

    const queryId = ++modelsQueryRef.current
    try {
      let ids: string[] = []
      let authFailed = false
      let hardError = ''

      if (window.electronAPI?.listAIModels) {
        const result = await window.electronAPI.listAIModels(trimmed, apiKey)
        if (queryId !== modelsQueryRef.current) return
        if (result.success) {
          ids = result.models || []
        } else {
          const err = (result.error || '').toLowerCase()
          if (err.includes('401') || err.includes('403') || err.includes('auth')) {
            authFailed = true
          } else {
            hardError = result.error || ''
          }
        }
      } else {
        // Fallback (browser / tests): try renderer fetch
        const base = trimmed.replace(/\/$/, '')
        const headers: Record<string, string> = { Accept: 'application/json' }
        if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
        const res = await fetch(`${base}/models`, { headers })
        if (res.status === 401 || res.status === 403) {
          authFailed = true
        } else if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        } else {
          const data = await res.json()
          const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
          ids = raw
            .map((m: { id?: string; name?: string }) => m?.id || m?.name || '')
            .filter((id: string) => Boolean(id))
            .sort((a: string, b: string) => a.localeCompare(b))
        }
      }

      if (queryId !== modelsQueryRef.current) return
      if (authFailed) {
        setAvailableModels([])
        setModelsOk(false)
        setModelsError('Authentication failed. Check your API key.')
        return
      }
      setAvailableModels(ids)
      setModelsOk(ids.length > 0)
      setModelsError(
        ids.length > 0
          ? ''
          : hardError
            ? 'Unable to list models. Enter the model name manually.'
            : ''
      )
    } catch {
      if (queryId !== modelsQueryRef.current) return
      setAvailableModels([])
      setModelsOk(false)
      setModelsError('')
    }
  }

  const scheduleQueryModels = (baseURL: string, apiKey: string) => {
    if (modelsDebounceRef.current) clearTimeout(modelsDebounceRef.current)
    modelsDebounceRef.current = setTimeout(() => {
      void queryModels(baseURL, apiKey)
    }, 400)
  }

  const applyBaseUrl = (url: string, opts?: { persist?: boolean; query?: boolean }) => {
    const next = {
      ...settingsRef.current,
      ai: { ...settingsRef.current.ai, baseURL: url },
    }
    setSettings(next)
    settingsRef.current = next
    if (opts?.query !== false) void queryModels(url, next.ai.apiKey)
    if (opts?.persist) void persist(next)
  }

  // Load models for an existing base URL when opening settings
  useEffect(() => {
    const { model } = initialSettings.ai
    let { baseURL, apiKey } = initialSettings.ai
    // Clear any persisted slash-command drafts that block normal editing
    const fixBase = isSlashCommandMode(baseURL)
    const fixModel = isSlashCommandMode(model)
    if (fixBase || fixModel) {
      const next = {
        ...initialSettings,
        ai: {
          ...initialSettings.ai,
          baseURL: fixBase ? '' : (baseURL ?? ''),
          model: fixModel ? '' : (model ?? ''),
        },
      }
      setSettings(next)
      settingsRef.current = next
      lastSavedRef.current = next
      void onSave(next)
      baseURL = next.ai.baseURL
      apiKey = next.ai.apiKey
    }
    if (baseURL?.trim() && !isSlashCommandMode(baseURL.trim())) {
      void queryModels(baseURL, apiKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setTheme = async (theme: ThemePreference) => {
    if (settings.theme === theme) return
    await persist({ ...settings, theme })
  }

  const requestProtectServerDataToggle = () => {
    setProtectConfirm(settings.protectServerData ? 'disable' : 'enable')
  }

  const confirmProtectServerDataToggle = async () => {
    if (!protectConfirm) return
    const protectServerData = protectConfirm === 'enable'
    setProtectConfirm(null)
    await persist({ ...settings, protectServerData })
    if (!protectServerData) onServersCleared?.()
  }

  const handleBack = async () => {
    await persistCurrentIfAiChanged()
    onBack()
  }

  const browseKey = async () => {
    if (!window.electronAPI) return
    const result = await window.electronAPI.openFileDialog({
      title: 'Select private key',
      properties: ['openFile'],
      filters: [
        { name: 'Private keys', extensions: ['pem', 'key', 'ppk', 'pub', '*'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (!result.canceled && result.filePaths[0]) {
      setNewKeyPath(result.filePaths[0])
      if (!newKeyName) {
        const base = result.filePaths[0].split(/[/\\]/).pop() || 'SSH Key'
        setNewKeyName(base)
      }
    }
  }

  const addKey = async () => {
    if (!newKeyName.trim() || !newKeyPath.trim()) return
    const key: AuthKey = {
      id: 'key_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
      name: newKeyName.trim(),
      privateKeyPath: newKeyPath.trim(),
      passphrase: newKeyPassphrase || undefined,
      createdAt: Date.now(),
    }
    await persist({ ...settings, keys: [...(settings.keys || []), key] })
    setNewKeyName('')
    setNewKeyPath('')
    setNewKeyPassphrase('')
  }

  const removeKey = async (id: string) => {
    await persist({
      ...settings,
      keys: (settings.keys || []).filter(k => k.id !== id),
    })
  }

  const navBtn = (id: SettingsSection, label: string, icon: React.ReactNode) => (
    <button
      key={id}
      onClick={() => {
        setSection(id)
        sectionRef(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-left transition-colors ${
        section === id
          ? 'bg-accent/15 text-accent'
          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
      }`}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div className="flex-1 flex flex-col bg-surface overflow-hidden">
      <div className="h-12 border-b border-border px-4 flex items-center justify-between bg-surface-elevated">
        <div className="flex items-center gap-3">
          <button
            onClick={() => void handleBack()}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium">Settings</span>
        </div>
        <span
          className={`text-xs text-accent transition-opacity duration-200 ${
            savedFlash ? 'opacity-100' : 'opacity-0'
          }`}
          aria-live="polite"
        >
          Saved
        </span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-48 border-r border-border p-3 space-y-1 bg-sidebar">
          {navBtn('general', 'General', <Settings2 className="h-4 w-4" />)}
          {navBtn('ai', 'AI', <Bot className="h-4 w-4" />)}
          {navBtn('auth', 'Authentication', <KeyRound className="h-4 w-4" />)}
        </aside>

        <div className="flex-1 overflow-y-auto p-6 space-y-10">
          {/* General */}
          <section ref={generalRef} id="settings-general" className="max-w-lg space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Settings2 className="h-5 w-5 text-accent" />
                General
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                App info, appearance, and connection defaults.
              </p>
            </div>

            <div className="rounded border border-border bg-card/50 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-muted-foreground">Version</span>
                <span className="font-medium font-mono">{appInfo?.version ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-muted-foreground">Build date</span>
                <span className="font-medium">
                  {appInfo ? formatBuildDate(appInfo.buildDate) : '—'}
                </span>
              </div>
            </div>

            <div className="rounded border border-border bg-card/50 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-muted-foreground">Data files</span>
                <button
                  onClick={() => window.electronAPI?.openDataFolder?.()}
                  className="px-3 py-1 rounded border border-border text-xs hover:bg-muted/40"
                >
                  Open folder
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                servers.json, categories.json, settings.json live here.{' '}
                {settings.protectServerData
                  ? 'servers.json is encrypted with your OS credential store and cannot be copied to another machine.'
                  : 'Copy these files to sync/backup across machines.'}
              </p>
            </div>

            <div className="rounded border border-border bg-card/50 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Protect server data</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Encrypts servers.json with your OS credential store. Not portable between machines.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.protectServerData === true}
                  onClick={requestProtectServerDataToggle}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    settings.protectServerData === true ? 'bg-accent' : 'bg-muted'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      settings.protectServerData === true ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>

            <div className="rounded border border-border bg-card/50 px-4 py-3 space-y-2">
              <div>
                <div className="text-sm font-medium">Connection timeout</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  How long to wait when connecting to a server before giving up.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="connection-timeout"
                  type="number"
                  min={1}
                  max={600}
                  step={1}
                  className="w-24 bg-background border border-border rounded px-3 py-1.5 text-sm tabular-nums"
                  value={settings.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT}
                  onChange={e => {
                    const n = Number(e.target.value)
                    setSettings(s => ({
                      ...s,
                      connectionTimeout: Number.isFinite(n) ? n : s.connectionTimeout,
                    }))
                  }}
                  onBlur={() => {
                    const connectionTimeout = normalizeConnectionTimeout(
                      settingsRef.current.connectionTimeout
                    )
                    void persist({
                      ...settingsRef.current,
                      connectionTimeout,
                    })
                  }}
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium">UI Style</div>
              <p className="text-xs text-muted-foreground">
                System follows your host appearance setting.
              </p>
              <div className="grid grid-cols-3 gap-2">
                {THEME_OPTIONS.map(option => {
                  const selected = settings.theme === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => void setTheme(option.id)}
                      aria-pressed={selected}
                      className={`flex flex-col items-center gap-2 rounded border px-3 py-3 text-sm transition-colors ${
                        selected
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border bg-card/50 text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground'
                      }`}
                    >
                      {option.icon}
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </section>

          {/* AI */}
          <section ref={aiRef} id="settings-ai" className="max-w-lg space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Bot className="h-5 w-5 text-accent" />
                Connect AI
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                OpenAI-compatible endpoint for asking questions about your servers — and optionally running SSH commands.
              </p>
            </div>

            <div className="flex items-center justify-between gap-4 rounded border border-border bg-card/50 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">AI features</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Show the Ask AI button when connected to a server.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.ai.enabled !== false}
                onClick={() => {
                  const enabled = settings.ai.enabled === false
                  void persist({
                    ...settings,
                    ai: { ...settings.ai, enabled },
                  })
                }}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                  settings.ai.enabled !== false ? 'bg-accent' : 'bg-muted'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    settings.ai.enabled !== false ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center justify-between gap-4 rounded border border-border bg-card/50 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">Allow AI to run commands</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Let Ask AI execute shell commands on SSH servers.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.ai.allowRunCommands === true}
                onClick={() => {
                  const allowRunCommands = settings.ai.allowRunCommands !== true
                  void persist({
                    ...settings,
                    ai: { ...settings.ai, allowRunCommands },
                  })
                }}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                  settings.ai.allowRunCommands === true ? 'bg-accent' : 'bg-muted'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    settings.ai.allowRunCommands === true ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div
              className={`flex items-center justify-between gap-4 rounded border border-border bg-card/50 px-4 py-3 ${
                settings.ai.allowRunCommands !== true ? 'opacity-50' : ''
              }`}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">Ask before running commands</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Confirm each command in the chat before it runs.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.ai.askBeforeRunningCommands !== false}
                disabled={settings.ai.allowRunCommands !== true}
                onClick={() => {
                  if (settings.ai.allowRunCommands !== true) return
                  const askBeforeRunningCommands = settings.ai.askBeforeRunningCommands === false
                  void persist({
                    ...settings,
                    ai: { ...settings.ai, askBeforeRunningCommands },
                  })
                }}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed ${
                  settings.ai.askBeforeRunningCommands !== false && settings.ai.allowRunCommands === true
                    ? 'bg-accent'
                    : 'bg-muted'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    settings.ai.askBeforeRunningCommands !== false && settings.ai.allowRunCommands === true
                      ? 'translate-x-6'
                      : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="rounded border border-border bg-card/50 px-4 py-3 space-y-2">
              <div>
                <div className="text-sm font-medium">Context length</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Max tokens for Ask AI history and prompts. Shown as a usage ring in the chat input.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="ai-context-length"
                  type="number"
                  min={1024}
                  max={1000000}
                  step={1024}
                  className="w-36 bg-background border border-border rounded px-3 py-1.5 text-sm tabular-nums"
                  value={settings.ai.contextLength ?? DEFAULT_CONTEXT_LENGTH}
                  onChange={e => {
                    const raw = e.target.value
                    const n = Number(raw)
                    setSettings(s => ({
                      ...s,
                      ai: {
                        ...s.ai,
                        contextLength: Number.isFinite(n) ? n : s.ai.contextLength,
                      },
                    }))
                  }}
                  onBlur={() => {
                    const raw = settingsRef.current.ai.contextLength
                    const n = Math.round(Number(raw))
                    const contextLength =
                      raw && Number.isFinite(n) && n > 0
                        ? Math.min(1_000_000, Math.max(1024, n))
                        : DEFAULT_CONTEXT_LENGTH
                    void persist({
                      ...settingsRef.current,
                      ai: { ...settingsRef.current.ai, contextLength },
                    })
                  }}
                />
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor="ai-api-key" className="text-xs text-muted-foreground">
                  API Key
                </label>
                <input
                  id="ai-api-key"
                  type="password"
                  className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm mt-1"
                  value={settings.ai.apiKey ?? ''}
                  onChange={e =>
                    setSettings(s => ({ ...s, ai: { ...s.ai, apiKey: e.target.value } }))
                  }
                  onBlur={() => {
                    void persistCurrentIfAiChanged()
                    const { baseURL, apiKey } = settingsRef.current.ai
                    if (baseURL?.trim() && !isSlashCommandMode(baseURL)) {
                      void queryModels(baseURL, apiKey)
                    }
                  }}
                  placeholder="your_api_key"
                />
              </div>
              <div>
                <label htmlFor="ai-base-url" className="text-xs text-muted-foreground">
                  Base URL
                </label>
                <div className="relative mt-1">
                  <input
                    id="ai-base-url"
                    className="relative z-10 w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                    value={settings.ai.baseURL ?? ''}
                    placeholder="Enter an API URL like https://example.com/v1 or search presets using /"
                    onFocus={() => setBaseUrlFocused(true)}
                    onChange={e => {
                      const value = e.target.value
                      setSettings(s => ({ ...s, ai: { ...s.ai, baseURL: value } }))
                      if (!isSlashCommandMode(value) && value.trim()) {
                        scheduleQueryModels(value, settingsRef.current.ai.apiKey)
                      } else {
                        if (modelsDebounceRef.current) clearTimeout(modelsDebounceRef.current)
                        setAvailableModels([])
                        setModelsOk(false)
                        setModelsError('')
                      }
                    }}
                    onBlur={() => {
                      setBaseUrlFocused(false)
                      const { baseURL, apiKey } = settingsRef.current.ai
                      // Don't persist slash-command drafts (e.g. "/" or "/lm")
                      if (isSlashCommandMode(baseURL)) {
                        const next = {
                          ...settingsRef.current,
                          ai: { ...settingsRef.current.ai, baseURL: lastSavedRef.current.ai.baseURL },
                        }
                        setSettings(next)
                        settingsRef.current = next
                        return
                      }
                      void persistCurrentIfAiChanged()
                      if (baseURL?.trim()) {
                        void queryModels(baseURL, apiKey)
                      }
                    }}
                  />
                  {baseUrlFocused && isSlashCommandMode(settings.ai.baseURL) && (() => {
                    const q = slashFilterQuery(settings.ai.baseURL)
                    const filtered = BASE_URL_PRESETS.filter(
                      p =>
                        !q ||
                        p.name.toLowerCase().includes(q) ||
                        p.url.toLowerCase().includes(q)
                    )
                    return (
                      <ul
                        className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-auto rounded border border-border bg-surface-elevated shadow-md"
                        onMouseDown={e => e.preventDefault()}
                      >
                        {filtered.length === 0 ? (
                          <li className="px-3 py-2 text-xs text-muted-foreground">No presets match</li>
                        ) : (
                          filtered.map(preset => (
                            <li key={preset.url}>
                              <button
                                type="button"
                                className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50"
                                onClick={() => {
                                  applyBaseUrl(preset.url, { persist: true, query: true })
                                  setBaseUrlFocused(false)
                                }}
                              >
                                <div className="font-medium">{preset.name}</div>
                                <div className="text-[11px] text-muted-foreground font-mono truncate">
                                  {preset.url}
                                </div>
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    )
                  })()}
                </div>
              </div>
              <div>
                <label htmlFor="ai-model" className="text-xs text-muted-foreground">
                  Model
                </label>
                <div className="relative mt-1">
                  <input
                    id="ai-model"
                    className="relative z-10 w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                    value={settings.ai.model ?? ''}
                    placeholder={
                      modelsOk
                        ? 'Enter a model name or list available models with /'
                        : modelsError ||
                          'Unable to automatically detect available models. Enter the model name.'
                    }
                    onFocus={() => setModelFocused(true)}
                    onChange={e =>
                      setSettings(s => ({ ...s, ai: { ...s.ai, model: e.target.value } }))
                    }
                    onBlur={() => {
                      setModelFocused(false)
                      const { model } = settingsRef.current.ai
                      if (isSlashCommandMode(model)) {
                        const next = {
                          ...settingsRef.current,
                          ai: { ...settingsRef.current.ai, model: lastSavedRef.current.ai.model },
                        }
                        setSettings(next)
                        settingsRef.current = next
                        return
                      }
                      void persistCurrentIfAiChanged()
                    }}
                  />
                  {modelFocused &&
                    modelsOk &&
                    isSlashCommandMode(settings.ai.model) &&
                    (() => {
                      const q = slashFilterQuery(settings.ai.model)
                      const filtered = availableModels.filter(id => !q || id.toLowerCase().includes(q))
                      return (
                        <ul
                          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-auto rounded border border-border bg-surface-elevated shadow-md"
                          onMouseDown={e => e.preventDefault()}
                        >
                          {filtered.length === 0 ? (
                            <li className="px-3 py-2 text-xs text-muted-foreground">No models match</li>
                          ) : (
                            filtered.map(id => (
                              <li key={id}>
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-left text-sm font-mono hover:bg-muted/50"
                                  onClick={() => {
                                    const next = {
                                      ...settingsRef.current,
                                      ai: { ...settingsRef.current.ai, model: id },
                                    }
                                    setSettings(next)
                                    settingsRef.current = next
                                    setModelFocused(false)
                                    void persist(next)
                                  }}
                                >
                                  {id}
                                </button>
                              </li>
                            ))
                          )}
                        </ul>
                      )
                    })()}
                </div>
              </div>
            </div>
          </section>

          {/* Authentication */}
          <section ref={authRef} id="settings-auth" className="max-w-lg space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-accent" />
                Authentication
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Manage SSH private keys to use when adding servers.
              </p>
            </div>

            <div className="space-y-2">
              {(settings.keys || []).length === 0 && (
                <div className="text-sm text-muted-foreground border border-dashed border-border rounded p-4">
                  No keys yet. Add a private key below to select it when connecting to servers.
                </div>
              )}
              {(settings.keys || []).map(key => (
                <div
                  key={key.id}
                  className="flex items-start gap-3 border border-border rounded p-3 bg-card"
                >
                  <KeyRound className="h-4 w-4 text-accent mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{key.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate font-mono">
                      {key.privateKeyPath}
                    </div>
                  </div>
                  <button
                    onClick={() => removeKey(key.id)}
                    className="p-1 text-muted-foreground hover:text-red-400"
                    title="Remove key"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="border border-border rounded p-4 space-y-3 bg-card/50">
              <div className="text-sm font-medium flex items-center gap-2">
                <Plus className="h-4 w-4" />
                Add key
              </div>
              <input
                className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                placeholder="Display name"
                value={newKeyName}
                onChange={e => setNewKeyName(e.target.value)}
              />
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-background border border-border rounded px-3 py-1.5 text-sm font-mono text-xs"
                  placeholder="Path to private key"
                  value={newKeyPath}
                  onChange={e => setNewKeyPath(e.target.value)}
                />
                <button
                  type="button"
                  onClick={browseKey}
                  className="px-3 py-1.5 rounded border border-border hover:bg-muted/40"
                  title="Browse"
                >
                  <FolderOpen className="h-4 w-4" />
                </button>
              </div>
              <input
                type="password"
                className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm"
                placeholder="Passphrase (optional)"
                value={newKeyPassphrase}
                onChange={e => setNewKeyPassphrase(e.target.value)}
              />
              <button
                type="button"
                onClick={addKey}
                disabled={!newKeyName.trim() || !newKeyPath.trim()}
                className="px-4 py-2 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
              >
                Add key
              </button>
            </div>
          </section>
        </div>
      </div>

      {protectConfirm && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setProtectConfirm(null)}
        >
          <div
            className="bg-surface-elevated border border-border rounded-lg p-5 w-full max-w-sm"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              {protectConfirm === 'enable' ? 'Protect server data?' : 'Disable protection?'}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {protectConfirm === 'enable'
                ? 'servers.json will be encrypted with your OS credential store. It will no longer be portable to another machine — you will not be able to copy it elsewhere and have it work.'
                : 'Turning this off will permanently remove all currently saved servers. This cannot be undone.'}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setProtectConfirm(null)}
                className="flex-1 py-2 rounded border border-border"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmProtectServerDataToggle()}
                className={`flex-1 py-2 rounded text-white ${
                  protectConfirm === 'enable' ? 'bg-accent' : 'bg-red-600'
                }`}
              >
                {protectConfirm === 'enable' ? 'Enable' : 'Disable & delete servers'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default SettingsPage
