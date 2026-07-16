import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { Server } from '../../shared/types'

interface EncryptedServersFile {
  v: 1
  /** base64 of safeStorage.encryptString(JSON.stringify(servers)) */
  enc: string
}

let serversPath = ''

/** Must be called once (e.g. app.whenReady) before any read/write. */
export function configureServersStore(serversPathArg: string): void {
  serversPath = serversPathArg
}

function ensureParentDir(): void {
  if (!serversPath) return
  try {
    mkdirSync(dirname(serversPath), { recursive: true })
  } catch {
    /* ignore */
  }
}

function readRawFile(): unknown {
  if (!serversPath) return null
  try {
    return JSON.parse(readFileSync(serversPath, 'utf8'))
  } catch {
    return null
  }
}

function isEncryptedShape(value: unknown): value is EncryptedServersFile {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { v?: unknown }).v === 1 &&
    typeof (value as { enc?: unknown }).enc === 'string'
  )
}

/** Peek the on-disk file format without decrypting. */
export function isEncryptedOnDisk(): boolean {
  return isEncryptedShape(readRawFile())
}

export function readServers(): Server[] {
  const raw = readRawFile()
  if (raw == null) return []
  if (Array.isArray(raw)) return raw as Server[]
  if (isEncryptedShape(raw)) {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[servers-store] servers.json is encrypted but OS encryption is unavailable; returning empty list')
      return []
    }
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(raw.enc, 'base64'))
      const parsed = JSON.parse(decrypted)
      return Array.isArray(parsed) ? (parsed as Server[]) : []
    } catch (e) {
      console.warn('[servers-store] Failed to decrypt servers.json', e)
      return []
    }
  }
  return []
}

export function writeServers(servers: Server[], encrypt: boolean): void {
  ensureParentDir()

  if (encrypt) {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[servers-store] Encryption requested but OS keychain encryption is unavailable; writing plaintext instead')
      writeFileSync(serversPath, JSON.stringify(servers, null, 2), 'utf8')
      return
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(servers))
    const wrapper: EncryptedServersFile = { v: 1, enc: encrypted.toString('base64') }
    writeFileSync(serversPath, JSON.stringify(wrapper), 'utf8')
    return
  }

  writeFileSync(serversPath, JSON.stringify(servers, null, 2), 'utf8')
}

/** Read, patch one server by id, and write back. Returns the updated server, or null if not found. */
export function updateServerFields(serverId: string, patch: Partial<Server>, encrypt: boolean): Server | null {
  const servers = readServers()
  const index = servers.findIndex(s => s.id === serverId)
  if (index === -1) return null
  const updated: Server = { ...servers[index], ...patch }
  servers[index] = updated
  writeServers(servers, encrypt)
  return updated
}
