import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, globalShortcut } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { Client } from 'ssh2'
import { Server, Category, AppSettings, ResolvedTheme, ThemePreference, AISessionsStore, TransferHistoryStore, DEFAULT_CONNECTION_TIMEOUT, normalizeConnectionTimeout, DEFAULT_CATEGORIES } from '../shared/types'
import { registerFsHandlers, closeAllRemoteClients, close as closeRemoteCache } from './fs-handlers'
import { getSummaryEntries } from './services/remote-cache'
import { configureServersStore, readServers, writeServers, updateServerFields } from './services/servers-store'
import { createHostKeyVerifier } from './services/host-key'
import {
  askAI,
  buildTreeSummaryFromRows,
  listAIModels,
  normalizeContextLength,
  DEFAULT_CONTEXT_LENGTH,
  sanitizeServerForAI,
  type AIAskContext,
  type AIHistoryMessage,
} from './services/ai'

declare const __BUILD_DATE__: string

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

const userDataPath = app.getPath('userData')
const SERVERS_PATH = join(userDataPath, 'servers.json')
const CATEGORIES_PATH = join(userDataPath, 'categories.json')
const SETTINGS_PATH = join(userDataPath, 'settings.json')
const AI_SESSIONS_PATH = join(userDataPath, 'ai-sessions.json')
const TRANSFER_HISTORY_PATH = join(userDataPath, 'transfer-history.json')

// servers.json may hold live credentials; route all reads/writes through servers-store.ts
// so it can transparently be plaintext or OS-keychain encrypted (safeStorage).
configureServersStore(SERVERS_PATH)

const DEFAULT_AI_SESSIONS: AISessionsStore = { sessions: [] }
const DEFAULT_TRANSFER_HISTORY: TransferHistoryStore = { transfers: [] }

const CHROME = {
  dark: { background: '#0a0a0f', symbol: '#f97316' },
  light: { background: '#ffffff', symbol: '#3f3f46' },
} as const

function normalizeTheme(value: unknown): ThemePreference {
  if (value === 'system' || value === 'light' || value === 'dark') return value
  return 'system'
}

function resolveThemePreference(preference: ThemePreference): ResolvedTheme {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function syncNativeThemeSource(preference: ThemePreference): void {
  if (nativeTheme.themeSource !== preference) {
    nativeTheme.themeSource = preference
  }
}

function ensureDataDir(): void {
  mkdirSync(userDataPath, { recursive: true })
}

function readJsonSync<T>(filePath: string, defaultValue: T): T {
  try {
    ensureDataDir()
    const data = readFileSync(filePath, 'utf8')
    return JSON.parse(data) as T
  } catch {
    return defaultValue
  }
}

function writeJsonSync<T>(filePath: string, data: T): void {
  ensureDataDir()
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

const DEFAULT_SETTINGS: AppSettings = {
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

function normalizeAISettings(ai: AppSettings['ai'] | undefined): AppSettings['ai'] {
  return {
    ...DEFAULT_SETTINGS.ai,
    ...(ai || {}),
    allowRunCommands: ai?.allowRunCommands === true,
    askBeforeRunningCommands: ai?.askBeforeRunningCommands !== false,
    contextLength: normalizeContextLength(ai?.contextLength ?? DEFAULT_CONTEXT_LENGTH),
  }
}

function currentProtectServerData(): boolean {
  return readJsonSync<AppSettings>(SETTINGS_PATH, DEFAULT_SETTINGS).protectServerData === true
}

function readAISessions(): AISessionsStore {
  const store = readJsonSync<AISessionsStore>(AI_SESSIONS_PATH, DEFAULT_AI_SESSIONS)
  if (!Array.isArray(store?.sessions)) return { sessions: [] }
  return { sessions: store.sessions }
}

function writeAISessions(store: AISessionsStore): void {
  writeJsonSync(AI_SESSIONS_PATH, { sessions: store.sessions || [] })
}

/** Mark every active session ended (app quit / crash recovery). */
function endAllActiveAISessions(): void {
  const store = readAISessions()
  const now = Date.now()
  let changed = false
  const sessions = store.sessions.map(s => {
    if (s.status !== 'active') return s
    changed = true
    return { ...s, status: 'ended' as const, endedAt: s.endedAt ?? now, updatedAt: now }
  })
  if (changed) writeAISessions({ sessions })
}

function deleteAISessionsForServer(serverId: string): void {
  const store = readAISessions()
  const sessions = store.sessions.filter(s => s.serverId !== serverId)
  if (sessions.length !== store.sessions.length) {
    writeAISessions({ sessions })
  }
}

function readTransferHistory(): TransferHistoryStore {
  const store = readJsonSync<TransferHistoryStore>(TRANSFER_HISTORY_PATH, DEFAULT_TRANSFER_HISTORY)
  if (!Array.isArray(store?.transfers)) return { transfers: [] }
  return { transfers: store.transfers }
}

function writeTransferHistory(store: TransferHistoryStore): void {
  writeJsonSync(TRANSFER_HISTORY_PATH, { transfers: store.transfers || [] })
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

function applyWindowChrome(resolved: ResolvedTheme, preference?: ThemePreference): void {
  const pref = preference ?? normalizeTheme(readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS).theme)
  syncNativeThemeSource(pref)
  if (!mainWindow || mainWindow.isDestroyed()) return
  const colors = CHROME[resolved]
  mainWindow.setBackgroundColor(colors.background)
  try {
    mainWindow.setTitleBarOverlay({
      color: colors.background,
      symbolColor: colors.symbol,
      height: 48,
    })
  } catch { /* ignore */ }
}

function resolveAppIcon(): string {
  if (isDev) {
    return join(app.getAppPath(), 'public', 'logo-icon.png')
  }
  return join(__dirname, '../renderer/logo-icon.png')
}

function createWindow(): void {
  const settings = readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS)
  const preference = normalizeTheme(settings?.theme)
  syncNativeThemeSource(preference)
  const initialTheme = resolveThemePreference(preference)
  const chrome = CHROME[initialTheme]

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: resolveAppIcon(),
    webPreferences: {
      // electron-vite emits .mjs for preload when package.json has "type": "module"
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: chrome.background,
      symbolColor: chrome.symbol,
      height: 48,
    },
    backgroundColor: chrome.background,
  })

  const revealWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    mainWindow.center()
    mainWindow.focus()
    mainWindow.moveTop()
    console.log('[PuppyFTP] Window ready')
  }

  // ready-to-show can be delayed/missed when DevTools opens early; always reveal with a fallback
  mainWindow.once('ready-to-show', () => {
    revealWindow()
    if (isDev) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[PuppyFTP] ready-to-show timed out — forcing window show')
      revealWindow()
      if (isDev && !mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.openDevTools({ mode: 'detach' })
      }
    }
  }, 3000)

  // Tray minimize-on-close only in packaged builds — in dev, close should quit so the app doesn't "vanish"
  mainWindow.on('close', (event) => {
    if (!isDev && tray && !mainWindow?.isDestroyed()) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[PuppyFTP] Failed to load', { code, desc, url })
    revealWindow()
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('store:get-servers', () => readServers())
ipcMain.handle('store:get-categories', () => readJsonSync(CATEGORIES_PATH, DEFAULT_CATEGORIES))
ipcMain.handle('store:save-servers', (_, servers: Server[]) => {
  const previous = readServers()
  writeServers(servers, currentProtectServerData())
  const nextIds = new Set(servers.map(s => s.id))
  for (const old of previous) {
    if (!nextIds.has(old.id)) deleteAISessionsForServer(old.id)
  }
  return true
})
ipcMain.handle('store:save-categories', (_, categories: Category[]) => {
  writeJsonSync(CATEGORIES_PATH, categories)
  return true
})
ipcMain.handle('store:get-ai-sessions', () => readAISessions())
ipcMain.handle('store:save-ai-sessions', (_, store: AISessionsStore) => {
  const sessions = Array.isArray(store?.sessions) ? store.sessions : []
  writeAISessions({ sessions })
  return true
})
ipcMain.handle('store:delete-ai-sessions-for-server', (_, serverId: string) => {
  if (serverId) deleteAISessionsForServer(serverId)
  return true
})
ipcMain.handle('store:end-active-ai-sessions', () => {
  endAllActiveAISessions()
  return true
})
ipcMain.handle('store:get-transfer-history', () => readTransferHistory())
ipcMain.handle('store:save-transfer-history', (_, store: TransferHistoryStore) => {
  const transfers = Array.isArray(store?.transfers) ? store.transfers : []
  writeTransferHistory({ transfers })
  return true
})
ipcMain.handle('store:get-settings', () => {
  let settings = readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS)
  if (!settings.keys) {
    settings = { ...settings, keys: [] }
    writeJsonSync(SETTINGS_PATH, settings)
  }
  const theme = normalizeTheme(settings.theme)
  const ai = normalizeAISettings(settings.ai)
  const connectionTimeout = normalizeConnectionTimeout(settings.connectionTimeout)
  const protectServerData = settings.protectServerData === true
  const needsWrite =
    settings.theme !== theme ||
    settings.connectionTimeout !== connectionTimeout ||
    settings.ai?.allowRunCommands !== ai.allowRunCommands ||
    settings.ai?.askBeforeRunningCommands !== ai.askBeforeRunningCommands ||
    settings.ai?.enabled !== ai.enabled ||
    settings.ai?.contextLength !== ai.contextLength ||
    settings.protectServerData !== protectServerData
  if (needsWrite) {
    settings = { ...settings, theme, ai, connectionTimeout, protectServerData }
    writeJsonSync(SETTINGS_PATH, settings)
  } else {
    settings = { ...settings, theme, ai, connectionTimeout, protectServerData }
  }
  return settings
})
ipcMain.handle('store:save-settings', (_, settings: AppSettings) => {
  const previousProtect = currentProtectServerData()
  const nextProtect = settings.protectServerData === true

  const next: AppSettings = {
    ...settings,
    theme: normalizeTheme(settings.theme),
    connectionTimeout: normalizeConnectionTimeout(settings.connectionTimeout),
    ai: normalizeAISettings(settings.ai),
    keys: settings.keys || [],
    protectServerData: nextProtect,
  }
  writeJsonSync(SETTINGS_PATH, next)
  applyWindowChrome(resolveThemePreference(next.theme), next.theme)

  // Keep servers.json's on-disk format in sync with the protectServerData toggle.
  if (previousProtect !== nextProtect) {
    if (previousProtect && !nextProtect) {
      // Turning protection off: the UI already warned the user this clears saved servers,
      // since silently writing decrypted credentials back to plaintext is not safe to assume.
      writeServers([], false)
    } else {
      // Turning protection on: re-persist current servers through safeStorage encryption.
      writeServers(readServers(), true)
    }
  }

  return true
})
ipcMain.handle('store:open-data-folder', async () => {
  await shell.openPath(userDataPath)
  return true
})

ipcMain.handle('dialog:open-file', async (_, options) => {
  const result = await dialog.showOpenDialog(options || {})
  return result
})
// Renderer content (including AI responses) can suggest arbitrary URLs; only ever hand off
// http(s) links to the OS shell so a malicious/compromised page can't launch file://, custom
// protocol handlers, etc.
ipcMain.handle('shell:open-external', async (_, url: string) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn('[PuppyFTP] Blocked shell:open-external for non-http(s) URL:', url)
    return false
  }
  await shell.openExternal(parsed.toString())
  return true
})
ipcMain.handle('app:get-info', () => ({
  version: app.getVersion(),
  buildDate: typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : new Date().toISOString().slice(0, 10),
}))
ipcMain.handle('theme:get-system', (): ResolvedTheme => nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
ipcMain.handle('theme:set-chrome', (_, resolved: ResolvedTheme) => {
  const preference = normalizeTheme(readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS).theme)
  applyWindowChrome(resolved === 'light' ? 'light' : 'dark', preference)
  return true
})


// --- Phase 2: SSH Terminal support ---
interface TerminalSession {
  client: any // eslint-disable-line @typescript-eslint/no-explicit-any
  stream: any // eslint-disable-line @typescript-eslint/no-explicit-any
  serverId: string
}

const terminalSessions = new Map<string, TerminalSession>()

const pendingCommandApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
>()

function generateSessionId(): string {
  return "term_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10)
}

function findTerminalSessionForServer(serverId: string): TerminalSession | undefined {
  for (const sess of terminalSessions.values()) {
    if (sess.serverId === serverId && sess.client) return sess
  }
  return undefined
}

function getConnectionTimeoutMs(server?: Server): number {
  if (typeof server?.readyTimeout === 'number' && Number.isFinite(server.readyTimeout) && server.readyTimeout > 0) {
    return Math.round(server.readyTimeout)
  }
  const settings = readJsonSync<AppSettings>(SETTINGS_PATH, DEFAULT_SETTINGS)
  return normalizeConnectionTimeout(settings.connectionTimeout) * 1000
}

function buildSSHConnectConfig(server: Server): Record<string, unknown> {
  const connectConfig: Record<string, unknown> = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    readyTimeout: getConnectionTimeoutMs(server),
    // Trust-on-first-use host key verification: warns (and can reject) if a previously
    // trusted host's SSH key ever changes, guarding against MITM / spoofed hosts.
    hostVerifier: createHostKeyVerifier({
      serverName: server.name,
      host: server.host,
      storedFingerprint: server.hostKeyFingerprint,
      onAccept: fingerprint => {
        updateServerFields(server.id, { hostKeyFingerprint: fingerprint }, currentProtectServerData())
      },
      getParentWindow: () => mainWindow,
    }),
  }

  if (server.authMethod === "privateKey" && server.privateKeyPath) {
    try {
      connectConfig.privateKey = readFileSync(server.privateKeyPath, "utf8")
      if (server.passphrase) connectConfig.passphrase = server.passphrase
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error("Failed to read private key: " + message)
    }
  } else if (server.password) {
    connectConfig.password = server.password
  }

  return connectConfig
}

function execOnSSHClient(
  client: InstanceType<typeof Client>,
  command: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', (data: Buffer | string) => {
        stdout += data.toString()
      })
      stream.stderr.on('data', (data: Buffer | string) => {
        stderr += data.toString()
      })
      stream.on('close', (code: number | null) => {
        resolve({ stdout, stderr, code: typeof code === 'number' ? code : null })
      })
      stream.on('error', (streamErr: Error) => {
        reject(streamErr)
      })
    })
  })
}

async function withTemporarySSHClient<T>(
  server: Server,
  fn: (client: InstanceType<typeof Client>) => Promise<T>
): Promise<T> {
  const client = new Client()
  try {
    await new Promise<void>((resolve, reject) => {
      client.on('ready', () => resolve())
      client.on('error', reject)
      client.connect(buildSSHConnectConfig(server) as any) // eslint-disable-line @typescript-eslint/no-explicit-any
    })
    return await fn(client)
  } finally {
    try {
      client.end()
    } catch {
      /* ignore */
    }
  }
}

async function runSSHCommandForServer(
  server: Server,
  command: string
): Promise<{ output: string; exitCode: number | null; error?: string }> {
  const existing = findTerminalSessionForServer(server.id)
  try {
    const result = existing?.client
      ? await execOnSSHClient(existing.client, command)
      : await withTemporarySSHClient(server, c => execOnSSHClient(c, command))
    const parts = [result.stdout, result.stderr].filter(Boolean)
    return {
      output: parts.join('\n') || '(no output)',
      exitCode: result.code,
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return { output: '', exitCode: null, error: message }
  }
}

function requestCommandApproval(
  win: BrowserWindow | null,
  command: string,
  serverName?: string
): Promise<boolean> {
  if (!win || win.isDestroyed()) return Promise.resolve(false)
  const requestId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (pendingCommandApprovals.has(requestId)) {
        pendingCommandApprovals.delete(requestId)
        resolve(false)
      }
    }, 300_000)
    pendingCommandApprovals.set(requestId, { resolve, timer })
    win.webContents.send('ai:command-approval', { requestId, command, serverName })
  })
}

ipcMain.handle(
  'ai:command-approval-response',
  (_event, payload: { requestId?: string; approved?: boolean }) => {
    const requestId = payload?.requestId
    if (!requestId) return false
    const pending = pendingCommandApprovals.get(requestId)
    if (!pending) return false
    clearTimeout(pending.timer)
    pendingCommandApprovals.delete(requestId)
    pending.resolve(payload?.approved === true)
    return true
  }
)

ipcMain.handle("terminal:create", async (_, server: Server) => {
  const sessionId = generateSessionId()
  return new Promise<string>((resolve, reject) => {
    let connectConfig: Record<string, unknown>
    try {
      connectConfig = buildSSHConnectConfig(server)
    } catch (e) {
      reject(e)
      return
    }

    const client = new Client()
    const session: TerminalSession = { client, stream: null, serverId: server.id }
    terminalSessions.set(sessionId, session)

    client.on("ready", () => {
      client.shell({ term: "xterm-256color" }, (err, stream: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (err) {
          client.end()
          terminalSessions.delete(sessionId)
          reject(err)
          return
        }
        session.stream = stream

        stream.on("data", (data: Buffer | string) => {
          const mainWin = mainWindow
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send("terminal:data", sessionId, data.toString())
          }
        })

        stream.on("close", () => {
          const mainWin = mainWindow
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send("terminal:exit", sessionId)
          }
          try { client.end() } catch { /* ignore */ }
          terminalSessions.delete(sessionId)
        })

        // Post-ready transport failures should also end the UI session.
        client.removeAllListeners("error")
        client.on("error", () => {
          const mainWin = mainWindow
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send("terminal:exit", sessionId)
          }
          try { client.end() } catch { /* ignore */ }
          terminalSessions.delete(sessionId)
        })
        client.on("close", () => {
          if (!terminalSessions.has(sessionId)) return
          const mainWin = mainWindow
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send("terminal:exit", sessionId)
          }
          terminalSessions.delete(sessionId)
        })

        resolve(sessionId)
      })
    })

    client.on("error", (err) => {
      terminalSessions.delete(sessionId)
      reject(err)
    })

    client.connect(connectConfig as any) // eslint-disable-line @typescript-eslint/no-explicit-any
  })
})

ipcMain.handle("terminal:input", async (_, sessionId: string, data: string) => {
  const sess = terminalSessions.get(sessionId)
  if (sess && sess.stream) {
    sess.stream.write(data)
  }
  return true
})

ipcMain.handle("terminal:resize", async (_, sessionId: string, cols: number, rows: number) => {
  const sess = terminalSessions.get(sessionId)
  if (sess && sess.stream) {
    try { sess.stream.setWindow(rows, cols, 0, 0) } catch { /* ignore */ }
  }
  return true
})

ipcMain.handle("terminal:close", async (_, sessionId: string) => {
  const sess = terminalSessions.get(sessionId)
  if (sess) {
    try { if (sess.stream && sess.stream.end) sess.stream.end() } catch { /* ignore */ }
    try { if (sess.client && sess.client.end) sess.client.end() } catch { /* ignore */ }
    terminalSessions.delete(sessionId)
  }
  return true
})

// --- Phase 5: Ask AI (OpenAI-compatible, main-process — avoids renderer CORS) ---
ipcMain.handle('ai:list-models', async (_, payload?: { baseURL?: string; apiKey?: string }) => {
  const settings = readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS)
  const baseURL = (payload?.baseURL ?? settings.ai?.baseURL ?? '').trim()
  const apiKey = (payload?.apiKey ?? settings.ai?.apiKey ?? '').trim()
  try {
    const models = await listAIModels({ baseURL, apiKey })
    return { success: true as const, models }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return { success: false as const, models: [] as string[], error: message }
  }
})

ipcMain.handle(
  'ai:ask',
  async (
    event,
    payload: {
      query: string
      context?: AIAskContext & { serverId?: string; includeCache?: boolean }
      history?: AIHistoryMessage[]
    }
  ) => {
    const settings = readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS)
    const ai = normalizeAISettings(settings.ai)
    const query = (payload?.query || '').trim()
    if (!query) return { success: false, error: 'Empty question' }
    if (ai.enabled === false) return { success: false, error: 'AI features are disabled in Settings' }
    if (!ai.baseURL?.trim()) return { success: false, error: 'No base URL. Configure in Settings > AI' }
    if (!ai.model?.trim()) return { success: false, error: 'No model. Configure in Settings > AI' }

    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
    const sendChunk = (chunk: string) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai:chunk', chunk)
    }
    const sendDone = (full: string) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai:done', full)
    }
    const sendError = (error: string) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai:error', error)
    }
    const sendCommandStatus = (status: {
      command: string
      phase: 'running' | 'done' | 'denied' | 'error'
      detail?: string
    }) => {
      if (win && !win.isDestroyed()) win.webContents.send('ai:command-status', status)
    }

    try {
      let context: AIAskContext = { ...(payload.context || {}) }
      let liveServer: Server | undefined

      // Prefer live server record from disk (never trust renderer-supplied credentials)
      const serverId = payload.context?.serverId || payload.context?.server?.id
      if (serverId) {
        const servers = readServers()
        const server = servers.find(s => s.id === serverId)
        if (server) {
          liveServer = server
          context = { ...context, server: sanitizeServerForAI(server) }
          if (payload.context?.includeCache !== false) {
            const rows = getSummaryEntries(serverId, 500)
            context.treeSummary = buildTreeSummaryFromRows(rows)
          }
        }
      } else if (context.server) {
        // Sanitized partial context from renderer (welcome / no id)
        context = {
          ...context,
          server: {
            id: context.server.id,
            name: context.server.name,
            protocol: context.server.protocol,
            host: context.server.host,
            port: context.server.port,
            username: context.server.username,
            lastKnownOs: context.server.lastKnownOs,
            notes: context.server.notes,
          },
        }
      }

      const history = Array.isArray(payload.history)
        ? payload.history.filter(
            (m): m is AIHistoryMessage =>
              !!m &&
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string' &&
              m.content.trim().length > 0
          )
        : undefined

      const connectionStatus = payload.context?.connectionStatus
      const isLiveConnection = connectionStatus === 'connected'

      const full = await askAI(
        ai,
        query,
        context,
        sendChunk,
        {
          runCommand:
            ai.allowRunCommands && liveServer?.protocol === 'ssh' && isLiveConnection
              ? async (command: string) => {
                  if (ai.askBeforeRunningCommands) {
                    const approved = await requestCommandApproval(
                      win,
                      command,
                      liveServer?.name
                    )
                    if (!approved) {
                      return { output: '', exitCode: null, error: 'denied' }
                    }
                  }
                  sendCommandStatus({ command, phase: 'running' })
                  return runSSHCommandForServer(liveServer!, command)
                }
              : undefined,
          onCommandStatus: sendCommandStatus,
        },
        history
      )
      sendDone(full)
      return { success: true, response: full }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      sendError(message)
      return { success: false, error: message }
    }
  }
)

app.whenReady().then(() => {
  app.on('browser-window-created', () => {})
  // Crash recovery: leftover "active" chats become read-only history
  endAllActiveAISessions()
  syncNativeThemeSource(normalizeTheme(readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS).theme))
  createWindow()

  // --- Phase 6: System Tray + Global Hotkey (packaged only — avoids "vanished" window in dev) ---
  const createTray = () => {
    if (tray || isDev) return
    try {
      const iconPath = resolveAppIcon()
      tray = new Tray(iconPath)
      const contextMenu = Menu.buildFromTemplate([
        { label: "Show PuppyFTP", click: () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() } } },
        { label: "Hide", click: () => mainWindow?.hide() },
        { type: "separator" },
        { label: "Quit", click: () => { tray?.destroy(); app.quit() } }
      ])
      tray.setToolTip("PuppyFTP")
      tray.setContextMenu(contextMenu)
      tray.on("click", () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) mainWindow.hide()
          else { mainWindow.show(); mainWindow.focus() }
        }
      })
    } catch (e) { console.error("Tray failed", e) }
  }

  createTray()

  try {
    globalShortcut.register("CommandOrControl+Shift+P", () => {
      if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return }
      if (mainWindow.isVisible()) mainWindow.hide()
      else { mainWindow.show(); mainWindow.focus() }
    })
  } catch (e) { console.error("Hotkey failed", e) }

  // Register Phase 3 FS handlers (see threat-model comment in fs-handlers.ts).
  const mainWindowRef = { current: mainWindow }
  registerFsHandlers(userDataPath, mainWindowRef)

  nativeTheme.on('updated', () => {
    const preference = normalizeTheme(readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS).theme)
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (preference !== 'system') return
    const resolved = resolveThemePreference('system')
    applyWindowChrome(resolved, preference)
    mainWindow.webContents.send('theme:system-changed', resolved)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  endAllActiveAISessions()
  try {
    closeAllRemoteClients()
  } catch (e) {
    console.error('[PuppyFTP] Failed to close remote clients on quit', e)
  }
  try {
    closeRemoteCache()
  } catch (e) {
    console.error('[PuppyFTP] Failed to close remote cache on quit', e)
  }
})
