export type Protocol = 'ftp' | 'ftps' | 'ftps-implicit' | 'sftp' | 'ssh' | 'telnet' | 'rdp'

export type ConnectionType = 'terminal' | 'file' | 'desktop'

/** Terminal transport: TCP (SSH/Telnet) vs local serial (COM) port. */
export type ConnectionMethod = 'network' | 'serial'

export type SerialDataBits = 5 | 6 | 7 | 8
export type SerialParity = 'none' | 'even' | 'odd' | 'mark' | 'space'
export type SerialStopBits = 1 | 1.5 | 2

export type AuthMethod = 'password' | 'privateKey'

/** UI / AI connection lifecycle for a server session. */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'lost' | 'failed'

export const DEFAULT_SERIAL_BAUD_RATE = 9600
export const DEFAULT_SERIAL_DATA_BITS: SerialDataBits = 8
export const DEFAULT_SERIAL_PARITY: SerialParity = 'none'
export const DEFAULT_SERIAL_STOP_BITS: SerialStopBits = 1

export function isTerminalProtocol(p: Protocol): boolean {
  return p === 'ssh' || p === 'telnet'
}

export function effectiveConnectionMethod(
  server: Pick<Server, 'connectionMethod'>
): ConnectionMethod {
  return server.connectionMethod === 'serial' ? 'serial' : 'network'
}

export function isSerialConnection(server: Pick<Server, 'connectionMethod'>): boolean {
  return effectiveConnectionMethod(server) === 'serial'
}

export interface SerialPortInfo {
  path: string
  friendlyName?: string
  manufacturer?: string
}

export function defaultPortForProtocol(protocol: Protocol): number {
  switch (protocol) {
    case 'ftps-implicit':
      return 990
    case 'ftp':
    case 'ftps':
      return 21
    case 'rdp':
      return 3389
    case 'telnet':
      return 23
    case 'sftp':
    case 'ssh':
    default:
      return 22
  }
}

export function protocolLabel(protocol: Protocol): string {
  switch (protocol) {
    case 'sftp':
      return 'SFTP'
    case 'ssh':
      return 'SSH'
    case 'telnet':
      return 'Telnet'
    case 'rdp':
      return 'RDP'
    case 'ftp':
      return 'FTP'
    case 'ftps':
      return 'FTPES'
    case 'ftps-implicit':
      return 'FTPS'
    default:
      return String(protocol).toUpperCase()
  }
}

export interface AuthKey {
  id: string
  name: string
  privateKeyPath: string
  passphrase?: string
  createdAt: number
}

export interface Server {
  id: string
  name: string
  protocol: Protocol
  host: string
  port: number
  username: string
  authMethod?: AuthMethod
  password?: string
  /** RDP domain (optional). */
  domain?: string
  /** Reference to a saved AuthKey in settings */
  keyId?: string
  privateKeyPath?: string
  passphrase?: string
  categoryId: string
  color?: string
  notes?: string
  passive?: boolean
  secure?: boolean
  /** FTPS only: allow self-signed / untrusted TLS certificates. Default: false (validate). */
  allowInvalidCertificate?: boolean
  /**
   * SSH/SFTP host key fingerprint (sha256 base64, OpenSSH-style without prefix).
   * Set on first successful connect (trust on first use); warn if it changes.
   */
  hostKeyFingerprint?: string
  readyTimeout?: number
  /** User-provided OS hint for Ask AI (e.g. "Ubuntu 24.04"). */
  lastKnownOs?: string
  /**
   * Terminal only. Missing / unknown ⇒ network (SSH/Telnet over TCP).
   * Serial uses a local COM port instead of host/port.
   */
  connectionMethod?: ConnectionMethod
  /** Serial COM path (e.g. COM3). Used when connectionMethod is serial. */
  serialPort?: string
  /** Serial baud rate. Default 9600 when opening. */
  baudRate?: number
  /** Serial data bits. Default 8. */
  dataBits?: SerialDataBits
  /** Serial parity. Default none. */
  parity?: SerialParity
  /** Serial stop bits. Default 1. */
  stopBits?: SerialStopBits
  createdAt: number
  lastConnectedAt?: number
  /** Last local explorer folder used for this server (file-transfer sessions). */
  lastLocalPath?: string
  /** Last local explorer list sort for this server (file-transfer sessions). */
  lastLocalSort?: ExplorerSortPreference
  /** Last remote explorer list sort for this server (file-transfer sessions). */
  lastRemoteSort?: ExplorerSortPreference
  order: number
}

export type ExplorerSortColumn = 'name' | 'size' | 'type' | 'mtime' | 'permissions'
export type ExplorerSortDirection = 'asc' | 'desc'

export interface ExplorerSortPreference {
  column: ExplorerSortColumn
  direction: ExplorerSortDirection
}

export interface Category {
  id: string
  name: string
  order: number
  collapsed?: boolean
}

/** Built-in category; cannot be renamed or deleted. */
export const UNCATEGORIZED_ID = 'uncategorized'

export const DEFAULT_CATEGORIES: Category[] = [
  { id: UNCATEGORIZED_ID, name: 'Uncategorized', order: 0, collapsed: false },
]

export interface RemoteCacheEntry {
  serverId: string
  path: string
  name: string
  type: 'file' | 'dir' | 'link'
  size: number
  mtime: number
  permissions?: string
  children?: string[]
}

export type ThemePreference = 'system' | 'light' | 'dark'

export type ResolvedTheme = 'light' | 'dark'

export interface AppInfo {
  version: string
  buildDate: string
}

/** Default max tokens for Ask AI history + prompts. */
export const DEFAULT_CONTEXT_LENGTH = 32768

export interface AppSettings {
  theme: ThemePreference
  /** Seconds to wait when establishing a server connection (SSH/SFTP/FTP). */
  connectionTimeout: number
  /**
   * When true, servers.json is encrypted with OS keychain (Electron safeStorage).
   * Not portable across machines. Default: false (plaintext JSON for easy backup/sync).
   */
  protectServerData: boolean
  ai: {
    enabled: boolean
    baseURL: string
    model: string
    apiKey: string
    /** When true, Ask AI may run shell commands on SSH servers via tool calls. */
    allowRunCommands: boolean
    /** When true (and allowRunCommands is on), prompt the user before each command. */
    askBeforeRunningCommands: boolean
    /** Max context tokens for Ask AI (history + prompt). */
    contextLength: number
  }
  keys: AuthKey[]
}

export interface ExploreProgressEvent {
  serverId: string
  currentPath: string
  processed: number
  percent: number
  status: 'starting' | 'exploring' | 'done' | 'cancelled'
}

export interface AIChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  kind?: 'text' | 'command-status'
  commandPhase?: 'running' | 'done' | 'denied' | 'error'
}

export type AISessionStatus = 'active' | 'ended'

export interface AISession {
  id: string
  serverId: string
  title: string
  messages: AIChatMessage[]
  status: AISessionStatus
  createdAt: number
  updatedAt: number
  endedAt?: number
}

export interface AISessionsStore {
  sessions: AISession[]
}

export interface AICommandApprovalRequest {
  requestId: string
  command: string
  serverName?: string
}

export type SettingsSection = 'general' | 'ai' | 'auth'

/** Default remote connection timeout in seconds. */
export const DEFAULT_CONNECTION_TIMEOUT = 20

export function normalizeConnectionTimeout(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_CONNECTION_TIMEOUT
  return Math.min(600, Math.max(1, Math.round(n)))
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'link';
  size: number;
  mtime: number;
  permissions?: string;
  path: string;
}

export type TransferDirection = 'up' | 'down'

export type TransferStatus = 'queued' | 'transferring' | 'completed' | 'failed'

/** Filter groups on the Transfers page. "current" = queued + transferring. */
export type TransferStatusFilter = 'current' | 'failed' | 'completed'

/** Scope of transfer history on the Transfers page. */
export type TransferSessionFilter = 'this' | 'all'

export interface TransferJob {
  id: string
  serverId: string
  serverName: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  fileName: string
  status: TransferStatus
  bytesTransferred: number
  bytesTotal: number
  percent: number
  /** Bytes per second while transferring; 0 otherwise. */
  speedBps: number
  error?: string
  /** App launch id that created this job (for This session / All sessions). */
  appSessionId: string
  createdAt: number
  startedAt?: number
  completedAt?: number
}

export interface TransferHistoryStore {
  transfers: TransferJob[]
}

export interface TransferProgressEvent {
  transferId: string
  serverId: string
  local: string
  remote: string
  direction: TransferDirection
  percent: number
  bytesTransferred?: number
  bytesTotal?: number
  speedBps?: number
  status?: 'transferring' | 'completed' | 'failed'
  error?: string
}

export interface TransferStartOptions {
  transferId: string
  bytesTotal?: number
}
