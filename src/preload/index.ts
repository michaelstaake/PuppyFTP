import { contextBridge, ipcRenderer } from 'electron'
import {
  Server,
  Category,
  AppSettings,
  AppInfo,
  ResolvedTheme,
  AISessionsStore,
  TransferHistoryStore,
  TransferProgressEvent,
  TransferStartOptions,
  FileEntry,
  RemoteCacheEntry,
  ExploreProgressEvent,
  AICommandApprovalRequest,
} from '../shared/types'
import type { ElectronAPI } from '../shared/electron-api'

const api: ElectronAPI = {
  getServers: (): Promise<Server[]> => ipcRenderer.invoke('store:get-servers'),
  getCategories: (): Promise<Category[]> => ipcRenderer.invoke('store:get-categories'),
  saveServers: (servers: Server[]): Promise<boolean> => ipcRenderer.invoke('store:save-servers', servers),
  saveCategories: (categories: Category[]): Promise<boolean> => ipcRenderer.invoke('store:save-categories', categories),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('store:get-settings'),
  saveSettings: (settings: AppSettings): Promise<boolean> => ipcRenderer.invoke('store:save-settings', settings),
  openFileDialog: (options?: Electron.OpenDialogOptions) => ipcRenderer.invoke('dialog:open-file', options),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:get-info'),
  getSystemTheme: (): Promise<ResolvedTheme> => ipcRenderer.invoke('theme:get-system'),
  setThemeChrome: (resolved: ResolvedTheme): Promise<boolean> =>
    ipcRenderer.invoke('theme:set-chrome', resolved),
  onSystemThemeChange: (callback: (resolved: ResolvedTheme) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, resolved: ResolvedTheme) => {
      callback(resolved)
    }
    ipcRenderer.on('theme:system-changed', listener)
    return () => {
      ipcRenderer.removeListener('theme:system-changed', listener)
    }
  },
  openDataFolder: (): Promise<boolean> => ipcRenderer.invoke('store:open-data-folder'),
  writeClipboardText: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('clipboard:write-text', text),
  readClipboardText: (): Promise<string> => ipcRenderer.invoke('clipboard:read-text'),
  captureRectToClipboard: (rect?: {
    x: number
    y: number
    width: number
    height: number
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('window:capture-rect-to-clipboard', rect),

  // Terminal (Phase 2)
  createTerminal: (server: Server): Promise<string> => ipcRenderer.invoke('terminal:create', server),
  sendTerminalData: (sessionId: string, data: string): Promise<void> => ipcRenderer.invoke('terminal:input', sessionId, data),
  resizeTerminal: (sessionId: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
  closeTerminal: (sessionId: string): Promise<void> => ipcRenderer.invoke('terminal:close', sessionId),
  claimTerminal: (
    sessionId: string
  ): Promise<{ success: boolean; scrollback: string }> => ipcRenderer.invoke('terminal:claim', sessionId),
  popOutTerminal: (
    serverId: string,
    scrollback?: string
  ): Promise<{ success: boolean; sessionId?: string; alreadyOpen?: boolean; error?: string }> =>
    ipcRenderer.invoke('terminal:pop-out', serverId, scrollback),
  dockTerminal: (
    serverId: string
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> =>
    ipcRenderer.invoke('terminal:dock', serverId),
  closeTerminalForServer: (serverId: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:close-for-server', serverId),
  respondTerminalScrollback: (requestId: string, scrollback: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:scrollback-response', { requestId, scrollback }),
  onTerminalData: (callback: (sessionId: string, data: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTerminalExit: (callback: (sessionId: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },
  onTerminalScrollbackRequest: (callback: (requestId: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, requestId: string) => callback(requestId)
    ipcRenderer.on('terminal:scrollback-request', listener)
    return () => ipcRenderer.removeListener('terminal:scrollback-request', listener)
  },
  onTerminalPopoutState: (
    callback: (state: {
      serverId: string
      poppedOut: boolean
      sessionId?: string
      ended?: boolean
      disconnect?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      state: {
        serverId: string
        poppedOut: boolean
        sessionId?: string
        ended?: boolean
        disconnect?: boolean
      }
    ) => callback(state)
    ipcRenderer.on('terminal:popout-state', listener)
    return () => ipcRenderer.removeListener('terminal:popout-state', listener)
  },

  // Explorer Phase 3 + 4
  listLocal: (dirPath: string): Promise<FileEntry[]> => ipcRenderer.invoke('fs:list-local', dirPath),
  listRemote: (serverId: string, dirPath: string): Promise<FileEntry[] | null> => ipcRenderer.invoke('fs:list-remote', serverId, dirPath),
  mkdirLocal: (dirPath: string): Promise<boolean> => ipcRenderer.invoke('fs:mkdir-local', dirPath),
  mkdirRemote: (serverId: string, dirPath: string): Promise<boolean> => ipcRenderer.invoke('fs:mkdir-remote', serverId, dirPath),
  deleteLocal: (filePath: string): Promise<boolean> => ipcRenderer.invoke('fs:delete-local', filePath),
  deleteRemote: (serverId: string, filePath: string): Promise<boolean> => ipcRenderer.invoke('fs:delete-remote', serverId, filePath),
  renameLocal: (oldPath: string, newPath: string): Promise<boolean> => ipcRenderer.invoke('fs:rename-local', oldPath, newPath),
  renameRemote: (serverId: string, oldPath: string, newPath: string): Promise<boolean> => ipcRenderer.invoke('fs:rename-remote', serverId, oldPath, newPath),
  uploadFile: (
    serverId: string,
    localPath: string,
    remotePath: string,
    options?: TransferStartOptions
  ): Promise<boolean> => ipcRenderer.invoke('fs:upload', serverId, localPath, remotePath, options),
  downloadFile: (
    serverId: string,
    remotePath: string,
    localPath: string,
    options?: TransferStartOptions
  ): Promise<boolean> => ipcRenderer.invoke('fs:download', serverId, remotePath, localPath, options),
  onTransferProgress: (callback: (data: TransferProgressEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: TransferProgressEvent) => callback(data)
    ipcRenderer.on('fs:transfer-progress', listener)
    return () => ipcRenderer.removeListener('fs:transfer-progress', listener)
  },
  exploreRemoteTree: (serverId: string, rootPath: string): Promise<boolean> => ipcRenderer.invoke('fs:explore-remote', serverId, rootPath),
  getCachedTree: (serverId: string): Promise<Record<string, RemoteCacheEntry>> => ipcRenderer.invoke('fs:get-cached-tree', serverId),
  searchCachedTree: (serverId: string, query: string): Promise<RemoteCacheEntry[]> => ipcRenderer.invoke('fs:search-cached', serverId, query),
  clearCache: (serverId?: string): Promise<boolean> => ipcRenderer.invoke('fs:clear-cache', serverId),
  onExploreProgress: (callback: (data: ExploreProgressEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: ExploreProgressEvent) => callback(data)
    ipcRenderer.on('fs:explore-progress', listener)
    return () => ipcRenderer.removeListener('fs:explore-progress', listener)
  },
  cancelExplore: (serverId: string): Promise<boolean> => ipcRenderer.invoke('fs:cancel-explore', serverId),
  disconnectRemote: (serverId: string): Promise<boolean> => ipcRenderer.invoke('fs:disconnect', serverId),
  onRemoteConnectionLost: (callback: (serverId: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, serverId: string) => callback(serverId)
    ipcRenderer.on('fs:connection-lost', listener)
    return () => ipcRenderer.removeListener('fs:connection-lost', listener)
  },

  // AI Phase 5
  askAI: (
    query: string,
    context?: Record<string, unknown>,
    history?: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<{ success: boolean; response?: string; error?: string }> =>
    ipcRenderer.invoke('ai:ask', { query, context, history }),
  listAIModels: (
    baseURL?: string,
    apiKey?: string
  ): Promise<{ success: boolean; models: string[]; error?: string }> =>
    ipcRenderer.invoke('ai:list-models', { baseURL, apiKey }),
  testAIConfiguration: (
    baseURL?: string,
    apiKey?: string,
    model?: string
  ): Promise<{ success: boolean; response?: string; error?: string }> =>
    ipcRenderer.invoke('ai:test', { baseURL, apiKey, model }),
  respondAICommandApproval: (requestId: string, approved: boolean): Promise<boolean> =>
    ipcRenderer.invoke('ai:command-approval-response', { requestId, approved }),
  getAISessions: (): Promise<AISessionsStore> =>
    ipcRenderer.invoke('store:get-ai-sessions'),
  saveAISessions: (store: AISessionsStore): Promise<boolean> =>
    ipcRenderer.invoke('store:save-ai-sessions', store),
  deleteAISessionsForServer: (serverId: string): Promise<boolean> =>
    ipcRenderer.invoke('store:delete-ai-sessions-for-server', serverId),
  endActiveAISessions: (): Promise<boolean> => ipcRenderer.invoke('store:end-active-ai-sessions'),
  getTransferHistory: (): Promise<TransferHistoryStore> =>
    ipcRenderer.invoke('store:get-transfer-history'),
  saveTransferHistory: (store: TransferHistoryStore): Promise<boolean> =>
    ipcRenderer.invoke('store:save-transfer-history', store),
  onAIChunk: (callback: (chunk: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, chunk: string) => callback(chunk)
    ipcRenderer.on('ai:chunk', listener)
    return () => ipcRenderer.removeListener('ai:chunk', listener)
  },
  onAIDone: (callback: (full: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, full: string) => callback(full)
    ipcRenderer.on('ai:done', listener)
    return () => ipcRenderer.removeListener('ai:done', listener)
  },
  onAIError: (callback: (error: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, error: string) => callback(error)
    ipcRenderer.on('ai:error', listener)
    return () => ipcRenderer.removeListener('ai:error', listener)
  },
  onAICommandApproval: (callback: (request: AICommandApprovalRequest) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, request: AICommandApprovalRequest) => callback(request)
    ipcRenderer.on('ai:command-approval', listener)
    return () => ipcRenderer.removeListener('ai:command-approval', listener)
  },
  onAICommandStatus: (
    callback: (status: {
      command: string
      phase: 'running' | 'done' | 'denied' | 'error'
      detail?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      status: { command: string; phase: 'running' | 'done' | 'denied' | 'error'; detail?: string }
    ) => callback(status)
    ipcRenderer.on('ai:command-status', listener)
    return () => ipcRenderer.removeListener('ai:command-status', listener)
  },

  platform: process.platform,
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type { ElectronAPI }
