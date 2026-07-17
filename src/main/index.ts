import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, globalShortcut, webContents, clipboard } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { Client } from 'ssh2'
import { Server, Category, AppSettings, ResolvedTheme, ThemePreference, AISessionsStore, TransferHistoryStore, DEFAULT_CONNECTION_TIMEOUT, normalizeConnectionTimeout, DEFAULT_FILES_SETTINGS, normalizeFilesSettings, DEFAULT_CATEGORIES, protocolLabel, isSerialConnection, DEFAULT_SERIAL_BAUD_RATE } from '../shared/types'
import { registerFsHandlers, closeAllRemoteClients, close as closeRemoteCache } from './fs-handlers'
import { registerRdpHandlers, closeAllRdpSessions } from './rdp-handlers'
import { getSummaryEntries } from './services/remote-cache'
import { configureServersStore, readServers, writeServers, updateServerFields } from './services/servers-store'
import {
  parseJumpListArgv,
  rebuildJumpList,
  setJumpListCurrentSessions,
  isJumpListEnabled,
  type JumpListAction,
} from './services/jump-list'
import { createHostKeyVerifier } from './services/host-key'
import { TelnetSession } from './services/telnet-session'
import { SerialSession, listSerialPorts } from './services/serial-session'
import {
  askAI,
  buildTreeSummaryFromRows,
  listAIModels,
  testAIConfiguration,
  normalizeContextLength,
  DEFAULT_CONTEXT_LENGTH,
  sanitizeServerForAI,
  type AIAskContext,
  type AIHistoryMessage,
} from './services/ai'

declare const __BUILD_DATE__: string

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Only one PuppyFTP process per machine — a second launch focuses the existing window.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

// Required for Windows Jump Lists (installed NSIS build only — not portable/dev).
if (isJumpListEnabled()) {
  app.setAppUserModelId('com.puppyftp.app')
}

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
  files: { ...DEFAULT_FILES_SETTINGS },
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

/** SSH terminal sessions that are currently shown in a separate BrowserWindow. */
const terminalPopouts = new Map<
  string,
  {
    window: BrowserWindow
    sessionId: string
    /** When true, closing the window docks the session back without ending SSH. */
    docking: boolean
  }
>()

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady()) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  mainWindow.moveTop()
}

type JumpListNavigatePayload = { action: JumpListAction; serverId: string }

let pendingJumpListNavigate: JumpListNavigatePayload | null = null
let mainRendererReady = false

function focusTerminalPopout(serverId: string): boolean {
  const existing = terminalPopouts.get(serverId)
  if (!existing || existing.window.isDestroyed()) return false
  if (existing.window.isMinimized()) existing.window.restore()
  if (!existing.window.isVisible()) existing.window.show()
  existing.window.focus()
  existing.window.moveTop()
  return true
}

function sendJumpListNavigate(payload: JumpListNavigatePayload): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingJumpListNavigate = payload
    if (app.isReady()) createWindow()
    return
  }
  if (!mainRendererReady) {
    pendingJumpListNavigate = payload
    focusMainWindow()
    return
  }
  pendingJumpListNavigate = null
  mainWindow.webContents.send('jump-list:navigate', payload)
}

function handleJumpListAction(payload: JumpListNavigatePayload): void {
  if (payload.action === 'focus') {
    if (focusTerminalPopout(payload.serverId)) {
      // Still tell the renderer to select the session so UI stays in sync.
      sendJumpListNavigate(payload)
      return
    }
    focusMainWindow()
    sendJumpListNavigate(payload)
    return
  }
  // connect — always bring main window forward and ask renderer to connect
  focusMainWindow()
  sendJumpListNavigate(payload)
}

function consumeJumpListArgv(argv: string[]): void {
  const parsed = parseJumpListArgv(argv)
  if (parsed) handleJumpListAction(parsed)
}

if (gotTheLock) {
  app.on('second-instance', (_event, argv) => {
    const parsed = parseJumpListArgv(argv)
    if (parsed) {
      handleJumpListAction(parsed)
      return
    }
    focusMainWindow()
  })
}

function applyChromeToWindow(win: BrowserWindow, theme: ResolvedTheme): void {
  if (win.isDestroyed()) return
  const colors = CHROME[theme]
  win.setBackgroundColor(colors.background)
  try {
    win.setTitleBarOverlay({
      color: colors.background,
      symbolColor: colors.symbol,
      height: 48,
    })
  } catch { /* ignore */ }
}

function applyWindowChrome(preference: ThemePreference, resolved?: ResolvedTheme): void {
  // Sync themeSource first so shouldUseDarkColors reflects the real OS preference
  // when switching from forced light/dark back to system.
  syncNativeThemeSource(preference)
  const theme = resolved ?? resolveThemePreference(preference)
  if (mainWindow && !mainWindow.isDestroyed()) {
    applyChromeToWindow(mainWindow, theme)
  }
  for (const pop of terminalPopouts.values()) {
    if (pop.window && !pop.window.isDestroyed()) {
      applyChromeToWindow(pop.window, theme)
    }
  }
}

function resolveAppIcon(): string {
  if (isDev) {
    return join(app.getAppPath(), 'public', 'logo-icon.png')
  }
  return join(__dirname, '../renderer/logo-icon.png')
}

function createWindow(): void {
  mainRendererReady = false
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
      // Preload is built as CJS (.cjs) so it can run under sandbox: true
      preload: join(__dirname, '../preload/index.cjs'),
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
  rebuildJumpList()
  return true
})
ipcMain.handle('jump-list:set-current-sessions', (_, serverIds: string[]) => {
  setJumpListCurrentSessions(Array.isArray(serverIds) ? serverIds.filter(id => typeof id === 'string') : [])
  return true
})
ipcMain.handle('jump-list:renderer-ready', () => {
  mainRendererReady = true
  if (pendingJumpListNavigate) {
    const payload = pendingJumpListNavigate
    pendingJumpListNavigate = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('jump-list:navigate', payload)
    }
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
  const files = normalizeFilesSettings(settings.files)
  const connectionTimeout = normalizeConnectionTimeout(settings.connectionTimeout)
  const protectServerData = settings.protectServerData === true
  const needsWrite =
    settings.theme !== theme ||
    settings.connectionTimeout !== connectionTimeout ||
    settings.ai?.allowRunCommands !== ai.allowRunCommands ||
    settings.ai?.askBeforeRunningCommands !== ai.askBeforeRunningCommands ||
    settings.ai?.enabled !== ai.enabled ||
    settings.ai?.contextLength !== ai.contextLength ||
    settings.files?.fontStyle !== files.fontStyle ||
    settings.files?.fontSize !== files.fontSize ||
    settings.protectServerData !== protectServerData
  if (needsWrite) {
    settings = { ...settings, theme, ai, files, connectionTimeout, protectServerData }
    writeJsonSync(SETTINGS_PATH, settings)
  } else {
    settings = { ...settings, theme, ai, files, connectionTimeout, protectServerData }
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
    files: normalizeFilesSettings(settings.files),
    keys: settings.keys || [],
    protectServerData: nextProtect,
  }
  writeJsonSync(SETTINGS_PATH, next)
  applyWindowChrome(next.theme)

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
ipcMain.handle('tray:set-tooltip', (_, text: unknown) => {
  if (typeof text !== 'string' || !tray) return false
  // Windows tray tooltips are capped at 128 characters.
  tray.setToolTip(text.slice(0, 128))
  return true
})
ipcMain.handle('theme:get-system', (): ResolvedTheme => nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
ipcMain.handle('theme:set-chrome', (_, resolved: ResolvedTheme) => {
  const preference = normalizeTheme(readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS).theme)
  applyWindowChrome(preference, resolved === 'light' ? 'light' : 'dark')
  return true
})

ipcMain.handle('clipboard:write-text', (_event, text: string) => {
  clipboard.writeText(typeof text === 'string' ? text : '')
  return true
})

ipcMain.handle('clipboard:read-text', () => clipboard.readText())

ipcMain.handle(
  'window:capture-rect-to-clipboard',
  async (
    event,
    rect?: { x?: number; y?: number; width?: number; height?: number }
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not available' }
      }
      const x = Math.max(0, Math.round(Number(rect?.x) || 0))
      const y = Math.max(0, Math.round(Number(rect?.y) || 0))
      const width = Math.max(1, Math.round(Number(rect?.width) || 0))
      const height = Math.max(1, Math.round(Number(rect?.height) || 0))
      const image =
        rect && width > 0 && height > 0
          ? await win.webContents.capturePage({ x, y, width, height })
          : await win.webContents.capturePage()
      if (!image || image.isEmpty()) {
        return { success: false, error: 'Capture failed' }
      }
      clipboard.writeImage(image)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }
)

// --- Phase 2: SSH / Telnet / Serial Terminal support ---
interface TerminalSession {
  /** SSH client (ssh2); null for Telnet/Serial. */
  client: any // eslint-disable-line @typescript-eslint/no-explicit-any
  /** SSH shell stream; null for Telnet/Serial. */
  stream: any // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Telnet session; null for SSH/Serial. */
  telnet: TelnetSession | null
  /** Serial session; null for SSH/Telnet. */
  serial: SerialSession | null
  serverId: string
  ownerWebContentsId: number | null
}

const terminalSessions = new Map<string, TerminalSession>()
/** Serialized xterm buffers held during pop-out / dock handoff. */
const terminalScrollbacks = new Map<string, string>()
/** In-flight scrollback requests from pop-out windows during dock. */
const pendingScrollbackRequests = new Map<string, (data: string) => void>()

const pendingCommandApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
>()

function generateSessionId(): string {
  return "term_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10)
}

function findTerminalSessionEntryForServer(
  serverId: string
): { sessionId: string; session: TerminalSession } | undefined {
  for (const [sessionId, sess] of terminalSessions) {
    if (sess.serverId === serverId && (sess.client || sess.telnet || sess.serial)) {
      return { sessionId, session: sess }
    }
  }
  return undefined
}

function findTerminalSessionForServer(serverId: string): TerminalSession | undefined {
  return findTerminalSessionEntryForServer(serverId)?.session
}

function notifyMainPopoutState(payload: {
  serverId: string
  poppedOut: boolean
  sessionId?: string
  /** Unexpected SSH death while popped out — show connection-lost UI. */
  ended?: boolean
  /** User closed the pop-out window — disconnect like the main Disconnect button. */
  disconnect?: boolean
}): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('terminal:popout-state', payload)
}

function sendToTerminalOwner(sessionId: string, channel: string, ...args: unknown[]): void {
  const sess = terminalSessions.get(sessionId)
  const ownerId = sess?.ownerWebContentsId
  if (ownerId != null) {
    try {
      const wc = webContents.fromId(ownerId)
      if (wc && !wc.isDestroyed()) {
        wc.send(channel, ...args)
        return
      }
    } catch { /* ignore */ }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function emitTerminalExit(sessionId: string, serverId: string): void {
  sendToTerminalOwner(sessionId, 'terminal:exit', sessionId)
  // Main window always learns about exits so connection UI stays in sync when popped out.
  if (mainWindow && !mainWindow.isDestroyed()) {
    const mainId = mainWindow.webContents.id
    const ownerId = terminalSessions.get(sessionId)?.ownerWebContentsId
    if (ownerId !== mainId) {
      mainWindow.webContents.send('terminal:exit', sessionId)
    }
  }
  const pop = terminalPopouts.get(serverId)
  if (pop && !pop.docking) {
    // Session died under a pop-out — clear placeholder state in the main UI.
    notifyMainPopoutState({ serverId, poppedOut: false, sessionId, ended: true })
  }
}

function stashTerminalScrollback(sessionId: string, scrollback: string): void {
  terminalScrollbacks.set(sessionId, typeof scrollback === 'string' ? scrollback : '')
}

function takeTerminalScrollback(sessionId: string): string {
  const value = terminalScrollbacks.get(sessionId) ?? ''
  terminalScrollbacks.delete(sessionId)
  return value
}

function appendTerminalScrollback(sessionId: string, chunk: string): void {
  if (!terminalScrollbacks.has(sessionId)) return
  terminalScrollbacks.set(sessionId, (terminalScrollbacks.get(sessionId) || '') + chunk)
}

function requestScrollbackFromPopout(win: BrowserWindow): Promise<string> {
  if (win.isDestroyed()) return Promise.resolve('')
  const requestId = `sb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (pendingScrollbackRequests.has(requestId)) {
        pendingScrollbackRequests.delete(requestId)
        resolve('')
      }
    }, 2000)
    pendingScrollbackRequests.set(requestId, (data: string) => {
      clearTimeout(timer)
      resolve(data)
    })
    try {
      win.webContents.send('terminal:scrollback-request', requestId)
    } catch {
      clearTimeout(timer)
      pendingScrollbackRequests.delete(requestId)
      resolve('')
    }
  })
}

function endTerminalSession(sessionId: string): void {
  const sess = terminalSessions.get(sessionId)
  if (!sess) return
  try { if (sess.stream?.end) sess.stream.end() } catch { /* ignore */ }
  try { if (sess.client?.end) sess.client.end() } catch { /* ignore */ }
  try { if (sess.telnet) sess.telnet.end() } catch { /* ignore */ }
  try { if (sess.serial) sess.serial.end() } catch { /* ignore */ }
  terminalSessions.delete(sessionId)
  terminalScrollbacks.delete(sessionId)
}

function closeTerminalPopoutWindow(serverId: string, opts: { endSession: boolean }): void {
  const pop = terminalPopouts.get(serverId)
  if (!pop) {
    if (opts.endSession) {
      const entry = findTerminalSessionEntryForServer(serverId)
      if (entry) endTerminalSession(entry.sessionId)
    }
    return
  }
  pop.docking = !opts.endSession
  if (!pop.window.isDestroyed()) {
    pop.window.close()
  }
}

function createTerminalPopoutWindow(serverId: string, sessionId: string, title: string): BrowserWindow {
  const settings = readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS)
  const preference = normalizeTheme(settings?.theme)
  syncNativeThemeSource(preference)
  const theme = resolveThemePreference(preference)
  const chrome = CHROME[theme]

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 480,
    minHeight: 320,
    show: false,
    autoHideMenuBar: true,
    icon: resolveAppIcon(),
    title: title || 'Terminal',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
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

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const query = {
    popout: '1',
    sessionId,
    serverId,
  }

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    const qs = new URLSearchParams(query).toString()
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${qs}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  return win
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

ipcMain.handle("serial:list-ports", async () => {
  return listSerialPorts()
})

ipcMain.handle("terminal:create", async (event, server: Server) => {
  const sessionId = generateSessionId()

  if (isSerialConnection(server)) {
    const path = server.serialPort?.trim()
    if (!path) {
      throw new Error('Serial port is required')
    }
    const serial = new SerialSession({
      path,
      baudRate: server.baudRate || DEFAULT_SERIAL_BAUD_RATE,
      dataBits: server.dataBits,
      parity: server.parity,
      stopBits: server.stopBits,
    })
    const session: TerminalSession = {
      client: null,
      stream: null,
      telnet: null,
      serial,
      serverId: server.id,
      ownerWebContentsId: event.sender.id,
    }
    terminalSessions.set(sessionId, session)

    serial.on('data', (text: string) => {
      appendTerminalScrollback(sessionId, text)
      sendToTerminalOwner(sessionId, 'terminal:data', sessionId, text)
    })

    serial.on('close', () => {
      if (!terminalSessions.has(sessionId)) return
      emitTerminalExit(sessionId, server.id)
      terminalSessions.delete(sessionId)
    })

    serial.on('error', () => {
      if (!terminalSessions.has(sessionId)) return
      emitTerminalExit(sessionId, server.id)
      try { serial.end() } catch { /* ignore */ }
      terminalSessions.delete(sessionId)
    })

    try {
      await serial.connect()
      return sessionId
    } catch (err) {
      terminalSessions.delete(sessionId)
      try { serial.end() } catch { /* ignore */ }
      throw err
    }
  }

  if (server.protocol === 'telnet') {
    const telnet = new TelnetSession({
      host: server.host,
      port: server.port || 23,
      timeoutMs: getConnectionTimeoutMs(server),
      terminalType: 'xterm-256color',
    })
    const session: TerminalSession = {
      client: null,
      stream: null,
      telnet,
      serial: null,
      serverId: server.id,
      ownerWebContentsId: event.sender.id,
    }
    terminalSessions.set(sessionId, session)

    telnet.on('data', (text: string) => {
      appendTerminalScrollback(sessionId, text)
      sendToTerminalOwner(sessionId, 'terminal:data', sessionId, text)
    })

    telnet.on('close', () => {
      if (!terminalSessions.has(sessionId)) return
      emitTerminalExit(sessionId, server.id)
      terminalSessions.delete(sessionId)
    })

    telnet.on('error', () => {
      if (!terminalSessions.has(sessionId)) return
      emitTerminalExit(sessionId, server.id)
      try { telnet.end() } catch { /* ignore */ }
      terminalSessions.delete(sessionId)
    })

    try {
      await telnet.connect()
      return sessionId
    } catch (err) {
      terminalSessions.delete(sessionId)
      try { telnet.end() } catch { /* ignore */ }
      throw err
    }
  }

  if (server.protocol !== 'ssh') {
    throw new Error(`Unsupported terminal protocol: ${server.protocol}`)
  }

  return new Promise<string>((resolve, reject) => {
    let connectConfig: Record<string, unknown>
    try {
      connectConfig = buildSSHConnectConfig(server)
    } catch (e) {
      reject(e)
      return
    }

    const client = new Client()
    const session: TerminalSession = {
      client,
      stream: null,
      telnet: null,
      serial: null,
      serverId: server.id,
      ownerWebContentsId: event.sender.id,
    }
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
          const text = data.toString()
          // While a scrollback stash exists (pop-out/dock handoff), keep buffering output.
          appendTerminalScrollback(sessionId, text)
          sendToTerminalOwner(sessionId, "terminal:data", sessionId, text)
        })

        stream.on("close", () => {
          emitTerminalExit(sessionId, server.id)
          try { client.end() } catch { /* ignore */ }
          terminalSessions.delete(sessionId)
        })

        // Post-ready transport failures should also end the UI session.
        client.removeAllListeners("error")
        client.on("error", () => {
          emitTerminalExit(sessionId, server.id)
          try { client.end() } catch { /* ignore */ }
          terminalSessions.delete(sessionId)
        })
        client.on("close", () => {
          if (!terminalSessions.has(sessionId)) return
          emitTerminalExit(sessionId, server.id)
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
  if (!sess) return true
  if (sess.serial) {
    sess.serial.write(data)
  } else if (sess.telnet) {
    sess.telnet.write(data)
  } else if (sess.stream) {
    sess.stream.write(data)
  }
  return true
})

ipcMain.handle("terminal:resize", async (_, sessionId: string, cols: number, rows: number) => {
  const sess = terminalSessions.get(sessionId)
  if (!sess) return true
  if (sess.serial) {
    try { sess.serial.resize(cols, rows) } catch { /* ignore */ }
  } else if (sess.telnet) {
    try { sess.telnet.resize(cols, rows) } catch { /* ignore */ }
  } else if (sess.stream) {
    try { sess.stream.setWindow(rows, cols, 0, 0) } catch { /* ignore */ }
  }
  return true
})

ipcMain.handle("terminal:close", async (event, sessionId: string) => {
  const sess = terminalSessions.get(sessionId)
  if (!sess) return true
  // Another window may own this session after a pop-out — don't tear it down from the old owner.
  if (sess.ownerWebContentsId != null && sess.ownerWebContentsId !== event.sender.id) {
    return true
  }
  endTerminalSession(sessionId)
  return true
})

ipcMain.handle("terminal:claim", async (event, sessionId: string) => {
  const sess = terminalSessions.get(sessionId)
  if (!sess || (!sess.stream && !sess.telnet && !sess.serial)) return { success: false as const, scrollback: '' }
  sess.ownerWebContentsId = event.sender.id
  const scrollback = takeTerminalScrollback(sessionId)
  return { success: true as const, scrollback }
})

ipcMain.handle("terminal:scrollback-response", (_event, payload: { requestId?: string; scrollback?: string }) => {
  const requestId = payload?.requestId
  if (!requestId || typeof requestId !== 'string') return false
  const resolve = pendingScrollbackRequests.get(requestId)
  if (!resolve) return false
  pendingScrollbackRequests.delete(requestId)
  resolve(typeof payload?.scrollback === 'string' ? payload.scrollback : '')
  return true
})

ipcMain.handle("terminal:pop-out", async (_event, serverId: string, scrollback?: string) => {
  if (!serverId || typeof serverId !== 'string') {
    return { success: false as const, error: 'Invalid server id' }
  }
  if (terminalPopouts.has(serverId)) {
    const existing = terminalPopouts.get(serverId)!
    if (!existing.window.isDestroyed()) {
      existing.window.focus()
      return { success: true as const, sessionId: existing.sessionId, alreadyOpen: true }
    }
    terminalPopouts.delete(serverId)
  }

  const entry = findTerminalSessionEntryForServer(serverId)
  if (!entry) {
    return { success: false as const, error: 'No active terminal session' }
  }

  // Stash before opening the pop-out so output during the handoff is buffered.
  stashTerminalScrollback(entry.sessionId, typeof scrollback === 'string' ? scrollback : '')

  const servers = readServers()
  const server = servers.find(s => s.id === serverId)
  const title = server
    ? isSerialConnection(server)
      ? `Serial — ${server.name}`
      : `${protocolLabel(server.protocol)} — ${server.name}`
    : 'Terminal'

  const win = createTerminalPopoutWindow(serverId, entry.sessionId, title)
  terminalPopouts.set(serverId, {
    window: win,
    sessionId: entry.sessionId,
    docking: false,
  })

  win.on('closed', () => {
    const pop = terminalPopouts.get(serverId)
    if (!pop || pop.window !== win) return
    terminalPopouts.delete(serverId)

    if (pop.docking) {
      notifyMainPopoutState({
        serverId,
        poppedOut: false,
        sessionId: pop.sessionId,
        ended: false,
      })
      return
    }

    // Native close ends the SSH session and disconnects cleanly in the main UI.
    const stillOpen = terminalSessions.has(pop.sessionId)
    if (stillOpen) {
      endTerminalSession(pop.sessionId)
    }
    notifyMainPopoutState({
      serverId,
      poppedOut: false,
      sessionId: pop.sessionId,
      disconnect: true,
    })
  })

  notifyMainPopoutState({
    serverId,
    poppedOut: true,
    sessionId: entry.sessionId,
  })

  return { success: true as const, sessionId: entry.sessionId }
})

ipcMain.handle("terminal:dock", async (_event, serverId: string) => {
  if (!serverId || typeof serverId !== 'string') {
    return { success: false as const, error: 'Invalid server id' }
  }
  const pop = terminalPopouts.get(serverId)
  if (!pop) {
    return { success: false as const, error: 'Terminal is not popped out' }
  }
  const sessionId = pop.sessionId

  // Capture scrollback from the pop-out window before it closes.
  let scrollback = ''
  if (!pop.window.isDestroyed()) {
    scrollback = await requestScrollbackFromPopout(pop.window)
  }
  stashTerminalScrollback(sessionId, scrollback)

  pop.docking = true
  if (!pop.window.isDestroyed()) {
    pop.window.close()
  } else {
    terminalPopouts.delete(serverId)
    notifyMainPopoutState({
      serverId,
      poppedOut: false,
      sessionId,
      ended: false,
    })
  }
  return { success: true as const, sessionId }
})

ipcMain.handle("terminal:close-for-server", async (_event, serverId: string) => {
  if (!serverId || typeof serverId !== 'string') return false
  closeTerminalPopoutWindow(serverId, { endSession: true })
  // If there was no pop-out, still end any in-main session for this server.
  const entry = findTerminalSessionEntryForServer(serverId)
  if (entry) endTerminalSession(entry.sessionId)
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
  'ai:test',
  async (_, payload?: { baseURL?: string; apiKey?: string; model?: string }) => {
    const settings = readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS)
    const ai = normalizeAISettings(settings.ai)
    const baseURL = (payload?.baseURL ?? ai.baseURL ?? '').trim()
    const apiKey = (payload?.apiKey ?? ai.apiKey ?? '').trim()
    const model = (payload?.model ?? ai.model ?? '').trim()
    try {
      const response = await testAIConfiguration({ baseURL, apiKey, model })
      return { success: true as const, response }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      return { success: false as const, error: message }
    }
  }
)

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

if (gotTheLock) {
  app.whenReady().then(() => {
    app.on('browser-window-created', () => {})
    // Crash recovery: leftover "active" chats become read-only history
    endAllActiveAISessions()
    syncNativeThemeSource(normalizeTheme(readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS).theme))
    rebuildJumpList()
    createWindow()
    // Cold-start Jump List / CLI connect (second-instance only fires when already running)
    consumeJumpListArgv(process.argv)

    // --- Phase 6: System Tray + Global Hotkey (packaged only — avoids "vanished" window in dev) ---
    const createTray = () => {
      if (tray || isDev) return
      try {
        const iconPath = resolveAppIcon()
        tray = new Tray(iconPath)
        const contextMenu = Menu.buildFromTemplate([
          { label: "Show PuppyFTP", click: () => { focusMainWindow() } },
          { label: "Hide", click: () => mainWindow?.hide() },
          { type: "separator" },
          { label: "Quit", click: () => { tray?.destroy(); app.quit() } }
        ])
        tray.setToolTip(`PuppyFTP ${app.getVersion()}`)
        tray.setContextMenu(contextMenu)
        tray.on("click", () => {
          if (mainWindow) {
            if (mainWindow.isVisible()) mainWindow.hide()
            else focusMainWindow()
          }
        })
      } catch (e) { console.error("Tray failed", e) }
    }

    createTray()

    try {
      globalShortcut.register("CommandOrControl+Shift+P", () => {
        if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return }
        if (mainWindow.isVisible()) mainWindow.hide()
        else focusMainWindow()
      })
    } catch (e) { console.error("Hotkey failed", e) }

    // Register Phase 3 FS handlers (see threat-model comment in fs-handlers.ts).
    const mainWindowRef = { current: mainWindow }
    registerFsHandlers(userDataPath, mainWindowRef)
    registerRdpHandlers(() => mainWindow)

    nativeTheme.on('updated', () => {
      const preference = normalizeTheme(readJsonSync(SETTINGS_PATH, DEFAULT_SETTINGS).theme)
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (preference !== 'system') return
      const resolved = resolveThemePreference('system')
      applyWindowChrome(preference, resolved)
      mainWindow.webContents.send('theme:system-changed', resolved)
    })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (!gotTheLock) return
  app.quit()
})

app.on('before-quit', () => {
  if (!gotTheLock) return
  endAllActiveAISessions()
  for (const serverId of [...terminalPopouts.keys()]) {
    closeTerminalPopoutWindow(serverId, { endSession: true })
  }
  for (const sessionId of [...terminalSessions.keys()]) {
    endTerminalSession(sessionId)
  }
  try {
    closeAllRdpSessions()
  } catch (e) {
    console.error('[PuppyFTP] Failed to close RDP sessions on quit', e)
  }
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
