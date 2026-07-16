import { BrowserWindow, ipcMain, screen } from 'electron'
import { createRequire } from 'module'
import type { Server } from '../shared/types'

const require = createRequire(import.meta.url)

export type RdpBounds = {
  x: number
  y: number
  width: number
  height: number
}

type RdpNative = {
  available: boolean
  create: (parentHwnd: Buffer, x: number, y: number, w: number, h: number) => string
  connect: (
    sessionId: string,
    options: {
      host: string
      port: number
      username: string
      password?: string
      domain?: string
      desktopWidth?: number
      desktopHeight?: number
    }
  ) => boolean
  isAlive?: (sessionId: string) => boolean
  setBounds: (sessionId: string, x: number, y: number, w: number, h: number) => boolean
  setVisible: (sessionId: string, visible: boolean) => boolean
  disconnect: (sessionId: string) => boolean
  destroy: (sessionId: string) => boolean
  destroyAll: () => boolean
}

type RdpSession = {
  sessionId: string
  nativeId: string
  serverId: string
}

let rdpNative: RdpNative | null = null
let rdpLoadError: string | null = null

function loadRdpNative(): RdpNative | null {
  if (rdpNative) return rdpNative
  try {
    const mod = require('puppyftp-rdp-host') as RdpNative
    if (!mod || mod.available === false) {
      rdpLoadError = 'RDP native host is not available on this build'
      return null
    }
    rdpNative = mod
    rdpLoadError = null
    return rdpNative
  } catch (e) {
    rdpLoadError = e instanceof Error ? e.message : String(e)
    console.error('[PuppyFTP] Failed to load RDP host', e)
    return null
  }
}

const sessionsById = new Map<string, RdpSession>()
const sessionsByServerId = new Map<string, string>()

function scaleFactorForWindow(win: BrowserWindow | null): number {
  if (!win || win.isDestroyed()) return 1
  try {
    return screen.getDisplayMatching(win.getBounds()).scaleFactor || 1
  } catch {
    return 1
  }
}

function toPhysicalBounds(bounds: RdpBounds, scaleFactor: number): RdpBounds {
  const s = scaleFactor > 0 ? scaleFactor : 1
  return {
    x: Math.round(bounds.x * s),
    y: Math.round(bounds.y * s),
    width: Math.max(1, Math.round(bounds.width * s)),
    height: Math.max(1, Math.round(bounds.height * s)),
  }
}

export function closeAllRdpSessions(): void {
  const native = loadRdpNative()
  if (native) {
    try {
      native.destroyAll()
    } catch (e) {
      console.error('[PuppyFTP] destroyAll RDP failed', e)
    }
  }
  sessionsById.clear()
  sessionsByServerId.clear()
}

export function closeRdpSessionsForServer(serverId: string): boolean {
  const sessionId = sessionsByServerId.get(serverId)
  if (!sessionId) return false
  return destroySession(sessionId)
}

function destroySession(sessionId: string): boolean {
  const session = sessionsById.get(sessionId)
  if (!session) return false
  const native = loadRdpNative()
  try {
    native?.destroy(session.nativeId)
  } catch (e) {
    console.warn('[PuppyFTP] RDP destroy failed', e)
  }
  sessionsById.delete(sessionId)
  if (sessionsByServerId.get(session.serverId) === sessionId) {
    sessionsByServerId.delete(session.serverId)
  }
  return true
}

function nativeAlive(native: RdpNative, nativeId: string): boolean {
  try {
    return native.isAlive?.(nativeId) === true
  } catch {
    return false
  }
}

export function registerRdpHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('rdp:available', async () => {
    const native = loadRdpNative()
    return { available: !!native, error: rdpLoadError }
  })

  ipcMain.handle(
    'rdp:create',
    async (
      event,
      server: Server,
      bounds: RdpBounds
    ): Promise<{ success: boolean; sessionId?: string; error?: string; reused?: boolean }> => {
      if (server.protocol !== 'rdp') {
        return { success: false, error: 'Server is not an RDP server' }
      }
      const native = loadRdpNative()
      if (!native) {
        return { success: false, error: rdpLoadError || 'RDP host unavailable' }
      }

      const existingId = sessionsByServerId.get(server.id)
      if (existingId) {
        const existing = sessionsById.get(existingId)
        if (existing && nativeAlive(native, existing.nativeId)) {
          try {
            native.setVisible(existing.nativeId, true)
          } catch {
            /* ignore */
          }
          return { success: true, sessionId: existingId, reused: true }
        }
        destroySession(existingId)
      }

      const win = BrowserWindow.fromWebContents(event.sender) || getMainWindow()
      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Could not get window handle' }
      }

      let hwnd: Buffer
      try {
        hwnd = win.getNativeWindowHandle()
      } catch {
        return { success: false, error: 'Could not get window handle' }
      }

      const phys = toPhysicalBounds(bounds, scaleFactorForWindow(win))

      let nativeId: string
      try {
        nativeId = native.create(hwnd, phys.x, phys.y, phys.width, phys.height)
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }

      const sessionId = `rdp_session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      sessionsById.set(sessionId, { sessionId, nativeId, serverId: server.id })
      sessionsByServerId.set(server.id, sessionId)

      try {
        native.connect(nativeId, {
          host: server.host,
          port: server.port || 3389,
          username: server.username || '',
          password: server.password || '',
          domain: server.domain || '',
          // Native host picks monitor size; these are only lower bounds.
          desktopWidth: 0,
          desktopHeight: 0,
        })
      } catch (e) {
        destroySession(sessionId)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }

      return { success: true, sessionId }
    }
  )

  ipcMain.handle(
    'rdp:set-bounds',
    async (_event, sessionId: string, bounds: RdpBounds): Promise<boolean> => {
      const session = sessionsById.get(sessionId)
      const native = loadRdpNative()
      if (!session || !native) return false
      const phys = toPhysicalBounds(bounds, scaleFactorForWindow(getMainWindow()))
      try {
        return native.setBounds(session.nativeId, phys.x, phys.y, phys.width, phys.height)
      } catch {
        return false
      }
    }
  )

  ipcMain.handle('rdp:set-visible', async (_event, sessionId: string, visible: boolean) => {
    const session = sessionsById.get(sessionId)
    const native = loadRdpNative()
    if (!session || !native) return false
    try {
      return native.setVisible(session.nativeId, visible)
    } catch {
      return false
    }
  })

  ipcMain.handle('rdp:close', async (_event, sessionId: string) => destroySession(sessionId))

  ipcMain.handle('rdp:close-for-server', async (_event, serverId: string) =>
    closeRdpSessionsForServer(serverId)
  )

  ipcMain.handle('rdp:is-alive', async (_event, sessionId: string) => {
    const session = sessionsById.get(sessionId)
    const native = loadRdpNative()
    if (!session || !native) return false
    return nativeAlive(native, session.nativeId)
  })
}
