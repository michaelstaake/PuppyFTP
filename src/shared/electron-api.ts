import type {
  AICommandApprovalRequest,
  AISession,
  AISessionsStore,
  AppInfo,
  AppSettings,
  Category,
  ExploreProgressEvent,
  FileEntry,
  RemoteCacheEntry,
  ResolvedTheme,
  SerialPortInfo,
  Server,
  TransferHistoryStore,
  TransferProgressEvent,
  TransferStartOptions,
} from './types'

export type ElectronAPI = {
  getServers: () => Promise<Server[]>
  getCategories: () => Promise<Category[]>
  saveServers: (servers: Server[]) => Promise<boolean>
  saveCategories: (categories: Category[]) => Promise<boolean>
  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<boolean>
  openFileDialog: (options?: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
  openExternal: (url: string) => Promise<void>
  getAppInfo: () => Promise<AppInfo>
  setTrayToolTip: (text: string) => Promise<boolean>
  getSystemTheme: () => Promise<ResolvedTheme>
  setThemeChrome: (resolved: ResolvedTheme) => Promise<boolean>
  onSystemThemeChange: (callback: (resolved: ResolvedTheme) => void) => () => void
  openDataFolder: () => Promise<boolean>
  writeClipboardText: (text: string) => Promise<boolean>
  readClipboardText: () => Promise<string>
  captureRectToClipboard: (rect?: {
    x: number
    y: number
    width: number
    height: number
  }) => Promise<{ success: boolean; error?: string }>

  listSerialPorts: () => Promise<SerialPortInfo[]>
  createTerminal: (server: Server) => Promise<string>
  sendTerminalData: (sessionId: string, data: string) => Promise<void>
  resizeTerminal: (sessionId: string, cols: number, rows: number) => Promise<void>
  closeTerminal: (sessionId: string) => Promise<void>
  claimTerminal: (
    sessionId: string
  ) => Promise<{ success: boolean; scrollback: string }>
  popOutTerminal: (
    serverId: string,
    scrollback?: string
  ) => Promise<{ success: boolean; sessionId?: string; alreadyOpen?: boolean; error?: string }>
  dockTerminal: (
    serverId: string
  ) => Promise<{ success: boolean; sessionId?: string; error?: string }>
  closeTerminalForServer: (serverId: string) => Promise<boolean>
  respondTerminalScrollback: (requestId: string, scrollback: string) => Promise<boolean>
  onTerminalData: (callback: (sessionId: string, data: string) => void) => () => void
  onTerminalExit: (callback: (sessionId: string) => void) => () => void
  onTerminalScrollbackRequest: (callback: (requestId: string) => void) => () => void
  onTerminalPopoutState: (
    callback: (state: {
      serverId: string
      poppedOut: boolean
      sessionId?: string
      ended?: boolean
      disconnect?: boolean
    }) => void
  ) => () => void

  rdpAvailable: () => Promise<{ available: boolean; error?: string | null }>
  createRdpSession: (
    server: Server,
    bounds: { x: number; y: number; width: number; height: number }
  ) => Promise<{ success: boolean; sessionId?: string; error?: string; reused?: boolean }>
  setRdpBounds: (
    sessionId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ) => Promise<boolean>
  setRdpVisible: (sessionId: string, visible: boolean) => Promise<boolean>
  closeRdpSession: (sessionId: string) => Promise<boolean>
  closeRdpForServer: (serverId: string) => Promise<boolean>
  rdpSessionAlive: (sessionId: string) => Promise<boolean>

  listLocal: (dirPath: string) => Promise<FileEntry[]>
  listRemote: (serverId: string, dirPath: string) => Promise<FileEntry[] | null>
  mkdirLocal: (dirPath: string) => Promise<boolean>
  mkdirRemote: (serverId: string, dirPath: string) => Promise<boolean>
  deleteLocal: (filePath: string) => Promise<boolean>
  deleteRemote: (serverId: string, filePath: string) => Promise<boolean>
  renameLocal: (oldPath: string, newPath: string) => Promise<boolean>
  renameRemote: (serverId: string, oldPath: string, newPath: string) => Promise<boolean>
  chmodRemote: (serverId: string, filePath: string, mode: number | string) => Promise<boolean>
  uploadFile: (
    serverId: string,
    localPath: string,
    remotePath: string,
    options?: TransferStartOptions
  ) => Promise<boolean>
  downloadFile: (
    serverId: string,
    remotePath: string,
    localPath: string,
    options?: TransferStartOptions
  ) => Promise<boolean>
  onTransferProgress: (callback: (data: TransferProgressEvent) => void) => () => void

  exploreRemoteTree: (serverId: string, rootPath: string) => Promise<boolean>
  getCachedTree: (serverId: string) => Promise<Record<string, RemoteCacheEntry>>
  searchCachedTree: (serverId: string, query: string) => Promise<RemoteCacheEntry[]>
  clearCache: (serverId?: string) => Promise<boolean>
  onExploreProgress: (callback: (data: ExploreProgressEvent) => void) => () => void
  cancelExplore: (serverId: string) => Promise<boolean>
  disconnectRemote: (serverId: string) => Promise<boolean>
  onRemoteConnectionLost: (callback: (serverId: string) => void) => () => void

  askAI: (
    query: string,
    context?: Record<string, unknown>,
    history?: { role: 'user' | 'assistant'; content: string }[]
  ) => Promise<{ success: boolean; response?: string; error?: string }>
  listAIModels: (
    baseURL?: string,
    apiKey?: string
  ) => Promise<{ success: boolean; models: string[]; error?: string }>
  testAIConfiguration: (
    baseURL?: string,
    apiKey?: string,
    model?: string
  ) => Promise<{ success: boolean; response?: string; error?: string }>
  respondAICommandApproval: (requestId: string, approved: boolean) => Promise<boolean>
  getAISessions: () => Promise<AISessionsStore>
  saveAISessions: (store: AISessionsStore) => Promise<boolean>
  deleteAISessionsForServer: (serverId: string) => Promise<boolean>
  endActiveAISessions: () => Promise<boolean>
  getTransferHistory: () => Promise<TransferHistoryStore>
  saveTransferHistory: (store: TransferHistoryStore) => Promise<boolean>
  onAIChunk: (callback: (chunk: string) => void) => () => void
  onAIDone: (callback: (full: string) => void) => () => void
  onAIError: (callback: (error: string) => void) => () => void
  onAICommandApproval: (callback: (request: AICommandApprovalRequest) => void) => () => void
  onAICommandStatus: (
    callback: (status: {
      command: string
      phase: 'running' | 'done' | 'denied' | 'error'
      detail?: string
    }) => void
  ) => () => void

  setJumpListCurrentSessions: (serverIds: string[]) => Promise<boolean>
  jumpListRendererReady: () => Promise<boolean>
  onJumpListNavigate: (
    callback: (payload: { action: 'focus' | 'connect'; serverId: string }) => void
  ) => () => void

  platform: NodeJS.Platform
}

// Satisfy noUnusedLocals if AISession is only used via AISessionsStore
export type { AISession }
