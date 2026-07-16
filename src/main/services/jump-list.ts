import { app, type JumpListCategory, type JumpListItem } from 'electron'
import type { Server } from '../../shared/types'
import { readServers } from './servers-store'

export type JumpListAction = 'focus' | 'connect'

export const JUMP_LIST_FOCUS_PREFIX = '--puppy-focus='
export const JUMP_LIST_CONNECT_PREFIX = '--puppy-connect='

const MAX_ITEMS_PER_CATEGORY = 10

let currentServerIds: string[] = []

/**
 * Jump Lists only for the installed (NSIS) Windows build.
 * Portable electron-builder builds set PORTABLE_EXECUTABLE_DIR; skip those and unpackaged/dev runs.
 */
export function isJumpListEnabled(): boolean {
  if (process.platform !== 'win32') return false
  if (!app.isPackaged) return false
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) return false
  return true
}

/** Build CLI args for a Jump List task (dev Electron needs the app entry path). */
export function buildJumpListTaskArgs(action: JumpListAction, serverId: string): string {
  const flag = action === 'focus' ? `${JUMP_LIST_FOCUS_PREFIX}${serverId}` : `${JUMP_LIST_CONNECT_PREFIX}${serverId}`
  if (process.defaultApp && process.argv.length >= 2) {
    return `"${process.argv[1]}" ${flag}`
  }
  return flag
}

export function parseJumpListArgv(argv: string[]): { action: JumpListAction; serverId: string } | null {
  for (const arg of argv) {
    if (arg.startsWith(JUMP_LIST_FOCUS_PREFIX)) {
      const serverId = arg.slice(JUMP_LIST_FOCUS_PREFIX.length)
      if (serverId) return { action: 'focus', serverId }
    }
    if (arg.startsWith(JUMP_LIST_CONNECT_PREFIX)) {
      const serverId = arg.slice(JUMP_LIST_CONNECT_PREFIX.length)
      if (serverId) return { action: 'connect', serverId }
    }
  }
  return null
}

export function setJumpListCurrentSessions(serverIds: string[]): void {
  currentServerIds = Array.isArray(serverIds) ? [...serverIds] : []
  rebuildJumpList()
}

function taskItem(server: Server, action: JumpListAction, description: string): JumpListItem {
  return {
    type: 'task',
    title: server.name || server.host || server.id,
    description,
    program: process.execPath,
    args: buildJumpListTaskArgs(action, server.id),
    iconPath: process.execPath,
    iconIndex: 0,
  }
}

function hasEverConnected(servers: Server[]): boolean {
  return servers.some(s => typeof s.lastConnectedAt === 'number' && s.lastConnectedAt > 0)
}

function recentServersExcluding(
  servers: Server[],
  excludeIds: Set<string>
): Server[] {
  return servers
    .filter(s => typeof s.lastConnectedAt === 'number' && s.lastConnectedAt > 0)
    .filter(s => !excludeIds.has(s.id))
    .sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0))
    .slice(0, MAX_ITEMS_PER_CATEGORY)
}

export function rebuildJumpList(): void {
  if (!isJumpListEnabled()) {
    if (process.platform === 'win32' && app.isPackaged) {
      try {
        app.setJumpList([])
      } catch {
        /* ignore */
      }
    }
    return
  }

  try {
    const servers = readServers()
    if (servers.length === 0) {
      app.setJumpList([])
      return
    }

    const byId = new Map(servers.map(s => [s.id, s]))
    const currentServers = currentServerIds
      .map(id => byId.get(id))
      .filter((s): s is Server => !!s)
      .slice(0, MAX_ITEMS_PER_CATEGORY)

    const currentIdSet = new Set(currentServers.map(s => s.id))
    const recentServers = recentServersExcluding(servers, currentIdSet)
    const everConnected = hasEverConnected(servers)
    const hasCurrent = currentServers.length > 0

    const categories: JumpListCategory[] = []

    if (hasCurrent || everConnected) {
      if (hasCurrent) {
        categories.push({
          type: 'custom',
          name: 'Current',
          items: currentServers.map(s => taskItem(s, 'focus', `Switch to ${s.name}`)),
        })
      }
      if (recentServers.length > 0) {
        categories.push({
          type: 'custom',
          name: 'Recent',
          items: recentServers.map(s => taskItem(s, 'connect', `Connect to ${s.name}`)),
        })
      }
    } else {
      const serverItems = [...servers]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
        .slice(0, MAX_ITEMS_PER_CATEGORY)
      categories.push({
        type: 'custom',
        name: 'Servers',
        items: serverItems.map(s => taskItem(s, 'connect', `Connect to ${s.name}`)),
      })
    }

    if (categories.length === 0) {
      const serverItems = [...servers]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
        .slice(0, MAX_ITEMS_PER_CATEGORY)
      categories.push({
        type: 'custom',
        name: 'Servers',
        items: serverItems.map(s => taskItem(s, 'connect', `Connect to ${s.name}`)),
      })
    }

    app.setJumpList(categories)
  } catch (e) {
    console.error('[PuppyFTP] Failed to rebuild Jump List', e)
  }
}
