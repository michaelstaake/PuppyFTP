import { app, ipcMain, nativeImage } from 'electron'
import type { BrowserWindow } from 'electron'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as ftp from 'basic-ftp'
import SftpClient from 'ssh2-sftp-client'
import { createReadStream, createWriteStream, readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, statSync } from 'fs'
import { Transform } from 'stream'
import { finished } from 'stream/promises'
import {
  Server,
  AppSettings,
  FileEntry,
  NativeDragRequest,
  RemoteCacheEntry,
  ExploreProgressEvent,
  normalizeConnectionTimeout,
} from '../shared/types'
import { readServers, updateServerFields } from './services/servers-store'
import { createHostKeyVerifier } from './services/host-key'
import {
  initRemoteCache,
  replaceDirListing,
  getTree,
  search,
  clear,
  close,
  getCachedTreeForServer,
} from './services/remote-cache'

/** Re-exported for index.ts (AI context) and app quit, so callers only need this module. */
export { getCachedTreeForServer, close }

/** Either remote client this app talks to — SFTP/SSH via ssh2-sftp-client, or FTP/FTPS via basic-ftp. */
type RemoteClient = SftpClient | ftp.Client

function isSftpClient(client: RemoteClient): client is SftpClient {
  return client instanceof SftpClient
}

/** Minimal shape shared by ssh2-sftp-client's FileInfo and basic-ftp's FileInfo. */
interface RawListItem {
  type: string | number
  name: string
  size?: number
  modifyTime?: number
  modifiedAt?: Date
  /** ssh2-sftp-client: e.g. { user: 'rwx', group: 'r-x', other: 'r--' } */
  rights?: { user?: string; group?: string; other?: string }
  /** basic-ftp UnixPermissions bitmasks (Read=4, Write=2, Execute=1). */
  permissions?: { user: number; group: number; world: number }
}

interface Listable {
  list(dirPath: string): Promise<RawListItem[]>
}

function isDirType(type: RawListItem['type']): boolean {
  return type === 'd' || type === 2
}

function toChildPath(protocol: Server['protocol'], parentPath: string, name: string): string {
  if (protocol === 'sftp' || protocol === 'ssh') return path.posix.join(parentPath, name)
  return (parentPath.endsWith('/') ? parentPath : parentPath + '/') + name
}

function rwxTriplet(bits: string | undefined): string {
  const s = (bits || '---').toLowerCase().padEnd(3, '-').slice(0, 3)
  return `${s.includes('r') ? 'r' : '-'}${s.includes('w') ? 'w' : '-'}${s.includes('x') ? 'x' : '-'}`
}

function modeBitsToRwx(n: number): string {
  return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`
}

/** Normalize listing metadata into a 9-char symbolic mode (e.g. rwxr-xr-x). */
function extractPermissions(item: RawListItem): string | undefined {
  if (item.rights) {
    return `${rwxTriplet(item.rights.user)}${rwxTriplet(item.rights.group)}${rwxTriplet(item.rights.other)}`
  }
  if (item.permissions) {
    return `${modeBitsToRwx(item.permissions.user)}${modeBitsToRwx(item.permissions.group)}${modeBitsToRwx(item.permissions.world)}`
  }
  return undefined
}

function toFileEntry(item: RawListItem, parentPath: string, protocol: Server['protocol']): FileEntry {
  const permissions = extractPermissions(item)
  return {
    name: item.name,
    type: isDirType(item.type) ? 'dir' : 'file',
    size: item.size || 0,
    mtime: item.modifyTime || (item.modifiedAt ? item.modifiedAt.getTime() : Date.now()),
    ...(permissions ? { permissions } : {}),
    path: toChildPath(protocol, parentPath, item.name),
  }
}

/** Accept octal string ("755"), number, or symbolic ("rwxr-xr-x") and return 0–0o777. */
function parseMode(mode: number | string): number | null {
  if (typeof mode === 'number' && Number.isFinite(mode)) {
    return mode & 0o777
  }
  const raw = String(mode).trim()
  if (/^[0-7]{3,4}$/.test(raw)) {
    return parseInt(raw.slice(-3), 8) & 0o777
  }
  const sym = raw.replace(/^[-dlbcps]/, '')
  if (/^[rwx-]{9}$/i.test(sym)) {
    let n = 0
    for (let i = 0; i < 9; i++) {
      const c = sym[i].toLowerCase()
      if (c === 'r') n |= 4 << (6 - Math.floor(i / 3) * 3)
      else if (c === 'w') n |= 2 << (6 - Math.floor(i / 3) * 3)
      else if (c === 'x') n |= 1 << (6 - Math.floor(i / 3) * 3)
    }
    return n & 0o777
  }
  return null
}

const remoteClients = new Map<string, RemoteClient>()

/** Set when FS handlers register so connect code can read settings.json. */
let settingsFilePath = ''

function readAppSettings(): AppSettings | null {
  try {
    if (!settingsFilePath) return null
    return JSON.parse(readFileSync(settingsFilePath, 'utf8')) as AppSettings
  } catch {
    return null
  }
}

function getConnectionTimeoutMs(server: Server): number {
  if (typeof server.readyTimeout === 'number' && Number.isFinite(server.readyTimeout) && server.readyTimeout > 0) {
    return Math.round(server.readyTimeout)
  }
  return normalizeConnectionTimeout(readAppSettings()?.connectionTimeout) * 1000
}

/** Whether servers.json is currently OS-keychain encrypted, so host-key fingerprint updates persist in the same format. */
function currentProtectServerData(): boolean {
  return readAppSettings()?.protectServerData === true
}

function isConnectionError(err: unknown): boolean {
  const errObj = err as { message?: unknown; code?: unknown } | undefined
  const msg = String(errObj?.message ?? err ?? '').toLowerCase()
  const code = String(errObj?.code ?? '').toLowerCase()
  return (
    /econnreset|econnrefused|etimedout|enotfound|epipe|enotconn|ehostunreach|enetunreach|socket|closed|not connected|no response|connection lost|broken pipe|timed out|handshake|disconnected/.test(
      msg
    ) ||
    /econnreset|econnrefused|etimedout|enotfound|epipe|enotconn|ehostunreach|enetunreach/.test(code)
  )
}

function dropRemoteClient(serverId: string): void {
  const client = remoteClients.get(serverId)
  if (!client) return
  remoteClients.delete(serverId)
  try {
    if (isSftpClient(client)) void client.end()
    else client.close()
  } catch {
    /* ignore */
  }
}

/** Close every open remote session (app quit). */
export function closeAllRemoteClients(): void {
  for (const serverId of Array.from(remoteClients.keys())) {
    dropRemoteClient(serverId)
  }
}

function notifyConnectionLost(mainWindowRef: { current: BrowserWindow | null }, serverId: string): void {
  dropRemoteClient(serverId)
  const win = mainWindowRef.current
  if (win && !win.isDestroyed()) {
    win.webContents.send('fs:connection-lost', serverId)
  }
}

function attachClientLossListeners(
  serverId: string,
  client: RemoteClient,
  mainWindowRef: { current: BrowserWindow | null }
): void {
  const onLost = () => {
    if (!remoteClients.has(serverId)) return
    notifyConnectionLost(mainWindowRef, serverId)
  }

  try {
    if (isSftpClient(client)) {
      client.on('end', onLost)
      client.on('close', onLost)
    }
    // basic-ftp's Client doesn't expose loss events we can subscribe to here — connection
    // errors surface as thrown exceptions on the next operation instead (see isConnectionError).
  } catch {
    /* ignore listener setup failures */
  }
}

/** ssh2-sftp-client's connect() options (host/port/username/readyTimeout + ssh2 auth fields). */
type SftpConnectOptions = Parameters<InstanceType<typeof SftpClient>['connect']>[0]

async function getRemoteClient(
  server: Server,
  mainWindowRef: { current: BrowserWindow | null }
): Promise<RemoteClient> {
  const key = server.id
  const existing = remoteClients.get(key)
  if (existing) return existing

  const connectionTimeoutMs = getConnectionTimeoutMs(server)

  if (server.protocol === 'sftp' || server.protocol === 'ssh') {
    const client = new SftpClient()
    const config: SftpConnectOptions = {
      host: server.host,
      port: server.port || 22,
      username: server.username,
      readyTimeout: connectionTimeoutMs,
      // Trust-on-first-use SSH host key verification (mirrors index.ts's terminal connections):
      // warns if a previously trusted host's key ever changes, guarding against MITM/spoofing.
      hostVerifier: createHostKeyVerifier({
        serverName: server.name,
        host: server.host,
        storedFingerprint: server.hostKeyFingerprint,
        onAccept: fingerprint => {
          updateServerFields(server.id, { hostKeyFingerprint: fingerprint }, currentProtectServerData())
        },
        getParentWindow: () => mainWindowRef.current,
      }),
    }
    if (server.authMethod === 'privateKey' && server.privateKeyPath) {
      config.privateKey = readFileSync(server.privateKeyPath, 'utf8')
      if (server.passphrase) config.passphrase = server.passphrase
    } else if (server.password) {
      config.password = server.password
    }
    await client.connect(config)
    remoteClients.set(key, client)
    attachClientLossListeners(key, client, mainWindowRef)
    return client
  }

  const client = new ftp.Client(connectionTimeoutMs)
  client.ftp.verbose = false
  let secure: boolean | 'implicit' = false
  if (server.protocol === 'ftps') secure = true
  else if (server.protocol === 'ftps-implicit') secure = 'implicit'
  const defaultPort = server.protocol === 'ftps-implicit' ? 990 : 21
  await client.access({
    host: server.host,
    port: server.port || defaultPort,
    user: server.username,
    password: server.password || undefined,
    secure,
    secureOptions: secure ? { rejectUnauthorized: !(server.allowInvalidCertificate === true) } : undefined,
  })
  remoteClients.set(key, client)
  attachClientLossListeners(key, client, mainWindowRef)
  return client
}

export function registerFsHandlers(userDataPath: string, mainWindowRef: { current: BrowserWindow | null }): void {
  settingsFilePath = path.join(userDataPath, 'settings.json')

  initRemoteCache(userDataPath)

  async function withRemoteClient<T>(
    serverId: string,
    fn: (server: Server, client: RemoteClient) => Promise<T>,
    fallback: T
  ): Promise<T> {
    const servers = readServers()
    const server = servers.find(s => s.id === serverId)
    if (!server) return fallback
    try {
      const client = await getRemoteClient(server, mainWindowRef)
      return await fn(server, client)
    } catch (e) {
      console.error('remote op error', e)
      if (isConnectionError(e)) {
        notifyConnectionLost(mainWindowRef, serverId)
      }
      return fallback
    }
  }

  ipcMain.handle('fs:list-local', async (_, dirPath: string): Promise<FileEntry[]> => {
    try {
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
      const result: FileEntry[] = []
      for (const ent of entries) {
        const full = path.join(dirPath, ent.name)
        try {
          const stat = await fsPromises.stat(full)
          result.push({
            name: ent.name,
            type: ent.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            mtime: stat.mtimeMs,
            path: full,
          })
        } catch {
          result.push({ name: ent.name, type: 'file', size: 0, mtime: 0, path: full })
        }
      }
      return result
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:stat-local', async (_, filePath: string): Promise<FileEntry | null> => {
    if (typeof filePath !== 'string' || !filePath.trim()) return null
    try {
      const stat = await fsPromises.stat(filePath)
      return {
        name: path.basename(filePath),
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        mtime: stat.mtimeMs,
        path: filePath,
      }
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'fs:copy-local-into',
    async (_, sources: string[], destDir: string): Promise<boolean> => {
      if (!Array.isArray(sources) || typeof destDir !== 'string' || !destDir.trim()) return false
      try {
        await fsPromises.mkdir(destDir, { recursive: true })
        for (const src of sources) {
          if (typeof src !== 'string' || !src.trim()) continue
          const name = path.basename(src)
          if (!name || name === '.' || name === '..') continue
          const dest = path.join(destDir, name)
          // Avoid copying a folder into itself / overlapping paths.
          const srcNorm = path.resolve(src)
          const destNorm = path.resolve(dest)
          if (srcNorm === destNorm || destNorm.startsWith(srcNorm + path.sep)) continue
          await fsPromises.cp(srcNorm, destNorm, { recursive: true, force: true })
        }
        return true
      } catch (e) {
        console.error('fs:copy-local-into', e)
        return false
      }
    }
  )

  ipcMain.handle('fs:list-remote', async (_, serverId: string, dirPath: string): Promise<FileEntry[] | null> => {
    const servers = readServers()
    const server = servers.find(s => s.id === serverId)
    if (!server) return null
    try {
      const client = await getRemoteClient(server, mainWindowRef)
      const listable: Listable = client
      const list = await listable.list(dirPath)
      return list.map(item => toFileEntry(item, dirPath, server.protocol))
    } catch (e) {
      console.error('list-remote error', e)
      const hadClient = remoteClients.has(serverId)
      if (isConnectionError(e) || !hadClient) {
        notifyConnectionLost(mainWindowRef, serverId)
        return null
      }
      return []
    }
  })

  ipcMain.handle('fs:mkdir-local', async (_, dirPath: string) => {
    try { await fsPromises.mkdir(dirPath, { recursive: true }); return true } catch { return false }
  })

  ipcMain.handle('fs:mkdir-remote', async (_, serverId: string, dirPath: string) => {
    return withRemoteClient(serverId, async (_server, client) => {
      if (isSftpClient(client)) {
        await client.mkdir(dirPath, true)
      } else {
        await client.ensureDir(dirPath)
      }
      return true
    }, false)
  })

  ipcMain.handle('fs:delete-local', async (_, filePath: string) => {
    try {
      const stat = await fsPromises.stat(filePath).catch(() => null)
      if (!stat) return false
      if (stat.isDirectory()) await fsPromises.rm(filePath, { recursive: true, force: true })
      else await fsPromises.unlink(filePath)
      return true
    } catch { return false }
  })

  ipcMain.handle('fs:delete-remote', async (_, serverId: string, filePath: string) => {
    return withRemoteClient(serverId, async (_server, client) => {
      if (isSftpClient(client)) {
        const stat = await client.stat(filePath).catch(() => null)
        if (stat?.isDirectory) await client.rmdir(filePath, true)
        else if (stat) await client.delete(filePath)
      } else {
        await client.remove(filePath)
      }
      return true
    }, false)
  })

  ipcMain.handle('fs:rename-local', async (_, oldPath: string, newPath: string) => {
    try { await fsPromises.rename(oldPath, newPath); return true } catch { return false }
  })

  ipcMain.handle('fs:rename-remote', async (_, serverId: string, oldPath: string, newPath: string) => {
    return withRemoteClient(serverId, async (_server, client) => {
      if (isSftpClient(client)) await client.rename(oldPath, newPath)
      else await client.rename(oldPath, newPath)
      return true
    }, false)
  })

  ipcMain.handle(
    'fs:chmod-remote',
    async (_, serverId: string, filePath: string, mode: number | string): Promise<boolean> => {
      const parsed = parseMode(mode)
      if (parsed == null) return false
      const octal = parsed.toString(8).padStart(3, '0')
      return withRemoteClient(serverId, async (_server, client) => {
        if (isSftpClient(client)) {
          await client.chmod(filePath, parsed)
        } else {
          // FTP has no standard chmod; SITE CHMOD is a common Unix extension.
          await client.send(`SITE CHMOD ${octal} ${filePath}`)
        }
        return true
      }, false)
    }
  )

  function sendTransferProgress(payload: Record<string, unknown>) {
    const win = mainWindowRef.current
    if (win && !win.isDestroyed()) {
      win.webContents.send('fs:transfer-progress', payload)
    }
  }

  function createTransferReporter(opts: {
    transferId: string
    serverId: string
    local: string
    remote: string
    direction: 'up' | 'down'
    bytesTotal: number
  }) {
    let lastBytes = 0
    let lastAt = Date.now()
    let lastSpeed = 0
    let lastEmitAt = 0
    let pendingTimer: ReturnType<typeof setTimeout> | null = null
    let pendingArgs: {
      bytesTransferred: number
      bytesTotal: number
      status: 'transferring' | 'completed' | 'failed'
      error?: string
    } | null = null
    const PROGRESS_THROTTLE_MS = 200

    const emitNow = (
      bytesTransferred: number,
      bytesTotal: number,
      status: 'transferring' | 'completed' | 'failed',
      error?: string
    ) => {
      const now = Date.now()
      const dt = Math.max(1, now - lastAt) / 1000
      const db = bytesTransferred - lastBytes
      if (db >= 0 && (status === 'transferring' || db > 0)) {
        // Smooth a bit so the UI doesn't flicker
        const instant = db / dt
        lastSpeed = lastSpeed > 0 ? lastSpeed * 0.6 + instant * 0.4 : instant
      }
      lastBytes = bytesTransferred
      lastAt = now
      lastEmitAt = now
      const total = bytesTotal > 0 ? bytesTotal : opts.bytesTotal
      const percent =
        total > 0
          ? Math.min(100, Math.round((bytesTransferred / total) * 100))
          : status === 'completed'
            ? 100
            : 0
      sendTransferProgress({
        transferId: opts.transferId,
        serverId: opts.serverId,
        local: opts.local,
        remote: opts.remote,
        direction: opts.direction,
        percent,
        bytesTransferred,
        bytesTotal: total,
        speedBps: status === 'transferring' ? Math.max(0, Math.round(lastSpeed)) : 0,
        status,
        error,
      })
    }

    const emit = (
      bytesTransferred: number,
      bytesTotal: number,
      status: 'transferring' | 'completed' | 'failed',
      error?: string
    ) => {
      // Always flush terminal states immediately
      if (status !== 'transferring') {
        if (pendingTimer) {
          clearTimeout(pendingTimer)
          pendingTimer = null
          pendingArgs = null
        }
        emitNow(bytesTransferred, bytesTotal, status, error)
        return
      }

      const now = Date.now()
      if (now - lastEmitAt >= PROGRESS_THROTTLE_MS) {
        if (pendingTimer) {
          clearTimeout(pendingTimer)
          pendingTimer = null
          pendingArgs = null
        }
        emitNow(bytesTransferred, bytesTotal, status, error)
        return
      }

      pendingArgs = { bytesTransferred, bytesTotal, status, error }
      if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null
          if (pendingArgs) {
            const args = pendingArgs
            pendingArgs = null
            emitNow(args.bytesTransferred, args.bytesTotal, args.status, args.error)
          }
        }, PROGRESS_THROTTLE_MS - (now - lastEmitAt))
      }
    }

    /** Count bytes flowing through a duplex stream (upload source or download sink). */
    const createByteCounter = () => {
      let transferred = 0
      const transform = new Transform({
        transform(chunk, _encoding, callback) {
          transferred += chunk.length
          emit(transferred, opts.bytesTotal, 'transferring')
          callback(null, chunk)
        },
      })
      return {
        stream: transform,
        get transferred() {
          return transferred
        },
      }
    }

    return { emit, createByteCounter }
  }

  ipcMain.handle(
    'fs:upload',
    async (
      _,
      serverId: string,
      localPath: string,
      remotePath: string,
      options?: { transferId?: string; bytesTotal?: number }
    ) => {
      const servers = readServers()
      const server = servers.find(s => s.id === serverId)
      if (!server) return false
      const transferId =
        options?.transferId || `xfer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      let bytesTotal = options?.bytesTotal || 0
      if (!bytesTotal) {
        try {
          const st = await fsPromises.stat(localPath)
          bytesTotal = st.size
        } catch {
          /* unknown size */
        }
      }
      const reporter = createTransferReporter({
        transferId,
        serverId,
        local: localPath,
        remote: remotePath,
        direction: 'up',
        bytesTotal,
      })
      reporter.emit(0, bytesTotal, 'transferring')
      try {
        const client = await getRemoteClient(server, mainWindowRef)
        // put()/uploadFrom() don't report file-accurate progress themselves — count stream
        // bytes instead so progress matches file bytes, not socket counters.
        const readStream = createReadStream(localPath)
        const counter = reporter.createByteCounter()
        readStream.pipe(counter.stream)
        if (isSftpClient(client)) {
          await client.put(counter.stream, remotePath)
        } else {
          await client.uploadFrom(counter.stream, remotePath)
        }
        reporter.emit(counter.transferred || bytesTotal || 0, bytesTotal, 'completed')
        return true
      } catch (e) {
        console.error(e)
        reporter.emit(0, bytesTotal, 'failed', String((e as Error)?.message || e))
        if (isConnectionError(e)) notifyConnectionLost(mainWindowRef, serverId)
        return false
      }
    }
  )

  ipcMain.handle(
    'fs:download',
    async (
      _,
      serverId: string,
      remotePath: string,
      localPath: string,
      options?: { transferId?: string; bytesTotal?: number }
    ) => {
      const servers = readServers()
      const server = servers.find(s => s.id === serverId)
      if (!server) return false
      const transferId =
        options?.transferId || `xfer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      const bytesTotal = options?.bytesTotal || 0
      const reporter = createTransferReporter({
        transferId,
        serverId,
        local: localPath,
        remote: remotePath,
        direction: 'down',
        bytesTotal,
      })
      reporter.emit(0, bytesTotal, 'transferring')
      try {
        const client = await getRemoteClient(server, mainWindowRef)
        // get()/downloadTo() don't report file-accurate progress themselves — count bytes
        // through a Transform into the local file instead.
        const counter = reporter.createByteCounter()
        const writeStream = createWriteStream(localPath)
        counter.stream.pipe(writeStream)
        try {
          if (isSftpClient(client)) {
            await client.get(remotePath, counter.stream)
          } else {
            await client.downloadTo(counter.stream, remotePath)
          }
          await finished(writeStream)
        } catch (err) {
          counter.stream.destroy()
          writeStream.destroy()
          throw err
        }
        reporter.emit(counter.transferred || bytesTotal || 0, bytesTotal, 'completed')
        return true
      } catch (e) {
        console.error(e)
        reporter.emit(0, bytesTotal, 'failed', String((e as Error)?.message || e))
        if (isConnectionError(e)) notifyConnectionLost(mainWindowRef, serverId)
        return false
      }
    }
  )

  // --- Phase 4: Full Remote Explore (cached in SQLite via services/remote-cache) ---
  const activeExplores = new Map<string, { cancelled: boolean }>()

  async function recursiveExplore(
    server: Server,
    rootPath: string,
    onProgress: (p: ExploreProgressEvent) => void
  ): Promise<void> {
    const serverId = server.id
    const exploreState = activeExplores.get(serverId) || { cancelled: false }
    activeExplores.set(serverId, exploreState)

    const client = await getRemoteClient(server, mainWindowRef)
    const listable: Listable = client
    const queue: string[] = [rootPath]
    let processed = 0

    onProgress({ serverId, currentPath: rootPath, processed, percent: 0, status: 'starting' })

    while (queue.length > 0) {
      if (exploreState.cancelled) {
        onProgress({ serverId, currentPath: '', processed, percent: 100, status: 'cancelled' })
        break
      }
      const current = queue.shift()!
      try {
        const entries = await listable.list(current)
        const mapped: FileEntry[] = entries.map(item => toFileEntry(item, current, server.protocol))
        for (const entry of mapped) {
          if (entry.type === 'dir') queue.push(entry.path)
        }
        replaceDirListing(serverId, current, mapped)

        processed++
        const percent = Math.min(99, Math.floor((processed / Math.max(1, queue.length + processed)) * 100))
        onProgress({ serverId, currentPath: current, processed, percent, status: 'exploring' })
      } catch (e) {
        console.warn('explore error', current, e)
        if (isConnectionError(e)) {
          notifyConnectionLost(mainWindowRef, serverId)
          onProgress({ serverId, currentPath: '', processed, percent: 100, status: 'cancelled' })
          break
        }
      }
    }

    if (!exploreState.cancelled) onProgress({ serverId, currentPath: '', processed, percent: 100, status: 'done' })
    activeExplores.delete(serverId)
  }

  ipcMain.handle('fs:explore-remote', async (_, serverId: string, rootPath: string) => {
    const servers = readServers()
    const server = servers.find(s => s.id === serverId)
    if (!server) return false
    const win = mainWindowRef.current
    const onProgress = (p: ExploreProgressEvent) => { if (win) win.webContents.send('fs:explore-progress', p) }
    try {
      await recursiveExplore(server, rootPath || '/', onProgress)
      return true
    } catch (e) {
      console.error(e)
      if (isConnectionError(e)) notifyConnectionLost(mainWindowRef, serverId)
      return false
    }
  })

  ipcMain.handle('fs:get-cached-tree', async (_, serverId: string): Promise<Record<string, RemoteCacheEntry>> =>
    getTree(serverId)
  )

  ipcMain.handle('fs:search-cached', async (_, serverId: string, query: string): Promise<RemoteCacheEntry[]> =>
    search(serverId, query)
  )

  ipcMain.handle('fs:clear-cache', async (_, serverId?: string) => {
    clear(serverId)
    return true
  })

  ipcMain.handle('fs:cancel-explore', async (_, serverId: string) => {
    const state = activeExplores.get(serverId)
    if (state) { state.cancelled = true; return true }
    return false
  })

  ipcMain.handle('fs:disconnect', async (_, serverId: string) => {
    const state = activeExplores.get(serverId)
    if (state) state.cancelled = true
    activeExplores.delete(serverId)
    dropRemoteClient(serverId)
    return true
  })

  // --- Native OS drag-out (Explorer/Finder) ---
  let nativeDragGeneration = 0

  function resolveDragIcon(): Electron.NativeImage {
    const candidates = [
      path.join(app.getAppPath(), 'public', 'logo-icon.png'),
      path.join(__dirname, '../renderer/logo-icon.png'),
      path.join(process.cwd(), 'public', 'logo-icon.png'),
    ]
    for (const candidate of candidates) {
      try {
        const img = nativeImage.createFromPath(candidate)
        if (!img.isEmpty()) return img
      } catch {
        /* try next */
      }
    }
    // 16x16 blue PNG fallback (macOS requires a non-empty icon).
    return nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHUlEQVQ4T2NkYGD4z0ABYBzVMKoBVAOGbwQDAF6uAf8Mk8cYAAAAAElFTkSuQmCC'
    )
  }

  function createRemoteDragPlaceholdersSync(
    entries: Array<Pick<FileEntry, 'name' | 'path' | 'type' | 'size'>>
  ): {
    stagingRoot: string
    items: Array<{ entry: Pick<FileEntry, 'name' | 'path' | 'type' | 'size'>; localPath: string }>
  } {
    const stagingRoot = path.join(
      os.tmpdir(),
      'puppyftp-drag',
      `Remote_${Date.now().toString(36)}`
    )
    mkdirSync(stagingRoot, { recursive: true })
    const items: Array<{
      entry: Pick<FileEntry, 'name' | 'path' | 'type' | 'size'>
      localPath: string
    }> = []
    for (const entry of entries) {
      if (!entry?.name || !entry?.path) continue
      const safeName = [...entry.name]
        .map((c) => (/[<>:"/\\|?*]/.test(c) || c.charCodeAt(0) <= 0x1f ? '_' : c))
        .join('')
      if (!safeName || safeName === '.' || safeName === '..') continue
      const localPath = path.join(stagingRoot, safeName)
      try {
        if (entry.type === 'dir') {
          mkdirSync(localPath, { recursive: true })
        } else {
          writeFileSync(localPath, Buffer.alloc(0))
        }
        items.push({ entry, localPath })
      } catch (e) {
        console.warn('drag placeholder failed', localPath, e)
      }
    }
    return { stagingRoot, items }
  }

  async function fillRemoteDragPlaceholders(
    serverId: string,
    items: Array<{ entry: Pick<FileEntry, 'name' | 'path' | 'type' | 'size'>; localPath: string }>
  ): Promise<void> {
    const servers = readServers()
    const server = servers.find(s => s.id === serverId)
    if (!server) throw new Error('Server not found')

    const client = await getRemoteClient(server, mainWindowRef)
    const listable: Listable = client

    const downloadFile = async (remotePath: string, localPath: string) => {
      await fsPromises.mkdir(path.dirname(localPath), { recursive: true })
      if (isSftpClient(client)) {
        await client.get(remotePath, localPath)
      } else {
        await client.downloadTo(localPath, remotePath)
      }
    }

    const downloadDir = async (remoteDir: string, localDir: string) => {
      await fsPromises.mkdir(localDir, { recursive: true })
      const itemsInDir = await listable.list(remoteDir)
      for (const item of itemsInDir) {
        const childRemote = toChildPath(server.protocol, remoteDir, item.name)
        const childLocal = path.join(localDir, item.name)
        if (isDirType(item.type)) {
          await downloadDir(childRemote, childLocal)
        } else {
          await downloadFile(childRemote, childLocal)
        }
      }
    }

    for (const { entry, localPath } of items) {
      if (!entry?.path || !localPath) continue
      if (entry.type === 'dir') {
        await downloadDir(entry.path, localPath)
      } else {
        await downloadFile(entry.path, localPath)
      }
    }
  }

  ipcMain.handle(
    'fs:prepare-remote-drag',
    async (
      _,
      serverId: string,
      entries: Array<Pick<FileEntry, 'name' | 'path' | 'type' | 'size'>>
    ): Promise<string[] | null> => {
      const generation = nativeDragGeneration
      try {
        if (typeof serverId !== 'string' || !Array.isArray(entries) || entries.length === 0) {
          return null
        }
        const { stagingRoot, items } = createRemoteDragPlaceholdersSync(entries)
        if (items.length === 0) return null
        await fillRemoteDragPlaceholders(serverId, items)
        if (generation !== nativeDragGeneration) {
          void fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
          return null
        }
        setTimeout(() => {
          void fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
        }, 15 * 60 * 1000)
        // On Windows multi-file, return the staging folder so startDrag can use a single path.
        if (items.length > 1 && process.platform !== 'darwin') {
          return [stagingRoot]
        }
        return items.map(i => i.localPath)
      } catch (e) {
        console.warn('fs:prepare-remote-drag failed', e)
        return null
      }
    }
  )

  ipcMain.on('fs:cancel-native-drag', () => {
    nativeDragGeneration += 1
  })

  // startDrag blocks until the OS gesture ends — only pass paths that already exist.
  ipcMain.on('fs:start-native-drag', (event, request: NativeDragRequest) => {
    try {
      if (!request || typeof request !== 'object') return

      const icon = resolveDragIcon()
      let filePaths: string[] = []

      if (request.kind === 'local') {
        filePaths = (request.paths || []).filter(
          (p): p is string => typeof p === 'string' && p.trim().length > 0
        )
      } else if (request.kind === 'remote') {
        // Remote must be prepared first via fs:prepare-remote-drag.
        console.warn('fs:start-native-drag: remote kind requires prepareRemoteDrag first')
        return
      }

      if (filePaths.length === 0) return

      if (filePaths.length === 1 || process.platform === 'darwin') {
        event.sender.startDrag({
          file: filePaths[0],
          ...(filePaths.length > 1 ? { files: filePaths } : {}),
          icon,
        })
        return
      }

      // Windows multi-select of already-local paths: stage into a temp folder.
      const stagingRoot = path.join(
        os.tmpdir(),
        'puppyftp-drag',
        `Local_${Date.now().toString(36)}`
      )
      mkdirSync(stagingRoot, { recursive: true })
      for (const src of filePaths) {
        const dest = path.join(stagingRoot, path.basename(src))
        try {
          const st = statSync(src)
          if (st.isDirectory()) cpSync(src, dest, { recursive: true })
          else copyFileSync(src, dest)
        } catch (e) {
          console.warn('local drag stage failed', src, e)
        }
      }
      event.sender.startDrag({ file: stagingRoot, icon })
      setTimeout(() => {
        void fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
      }, 15 * 60 * 1000)
    } catch (e) {
      console.warn('fs:start-native-drag failed', e)
    }
  })
}
