import Database from 'better-sqlite3'
import { existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import * as path from 'path'
import type { RemoteCacheEntry, FileEntry } from '../../shared/types'

/** Row shape as insert/select from the `entries` table. */
interface EntryRow {
  server_id: string
  path: string
  name: string
  type: 'file' | 'dir' | 'link'
  size: number
  mtime: number
  parent_path: string | null
}

interface Statements {
  deleteChildren: Database.Statement
  insertEntry: Database.Statement
}

let db: Database.Database | null = null
let stmts: Statements | null = null
let dbFilePath = ''

function prepareStatements(instance: Database.Database): Statements {
  return {
    deleteChildren: instance.prepare('DELETE FROM entries WHERE server_id = ? AND parent_path = ?'),
    insertEntry: instance.prepare(
      `INSERT OR REPLACE INTO entries (server_id, path, name, type, size, mtime, parent_path)
       VALUES (@server_id, @path, @name, @type, @size, @mtime, @parent_path)`
    ),
  }
}

function getDb(): Database.Database {
  if (db) return db
  db = new Database(dbFilePath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      server_id   TEXT NOT NULL,
      path        TEXT NOT NULL,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      size        INTEGER NOT NULL DEFAULT 0,
      mtime       INTEGER NOT NULL DEFAULT 0,
      parent_path TEXT,
      PRIMARY KEY (server_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_entries_name   ON entries(server_id, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(server_id, parent_path);
  `)
  migrateFromJson(db)
  stmts = prepareStatements(db)
  return db
}

function getStatements(): Statements {
  getDb()
  return stmts!
}

/** Legacy JSON cache shape (`remote-cache.json`), keyed by server id then path. */
interface LegacyTreeEntry {
  name?: string
  type?: string
  size?: number
  mtime?: number
  path?: string
}

function deriveParentPath(entryPath: string): string | null {
  if (!entryPath) return null
  const parent = path.posix.dirname(entryPath)
  if (parent === entryPath) return null
  return parent
}

/** One-time migration from the old JSON cache file, if present. Corrupt JSON just starts empty. */
function migrateFromJson(instance: Database.Database): void {
  const jsonPath = join(path.dirname(dbFilePath), 'remote-cache.json')
  if (!existsSync(jsonPath)) return
  try {
    const raw = readFileSync(jsonPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, Record<string, LegacyTreeEntry>>

    const insert = instance.prepare(
      `INSERT OR REPLACE INTO entries (server_id, path, name, type, size, mtime, parent_path)
       VALUES (@server_id, @path, @name, @type, @size, @mtime, @parent_path)`
    )
    const migrateAll = instance.transaction(() => {
      for (const [serverId, tree] of Object.entries(parsed || {})) {
        if (!tree || typeof tree !== 'object') continue
        for (const [entryPath, entry] of Object.entries(tree)) {
          if (!entry) continue
          const type: EntryRow['type'] =
            entry.type === 'dir' || entry.type === 'link' ? entry.type : 'file'
          insert.run({
            server_id: serverId,
            path: entryPath,
            name: entry.name || path.posix.basename(entryPath) || entryPath,
            type,
            size: entry.size || 0,
            mtime: entry.mtime || 0,
            parent_path: deriveParentPath(entryPath),
          })
        }
      }
    })
    migrateAll()

    try {
      renameSync(jsonPath, `${jsonPath}.bak`)
    } catch {
      /* rename is best-effort; migration already committed */
    }
  } catch {
    /* corrupt JSON — start with an empty DB */
  }
}

/** Set the DB path and open it (migrating from JSON if needed). Call once at app startup. */
export function initRemoteCache(userDataPath: string): void {
  dbFilePath = join(userDataPath, 'remote-cache.db')
  getDb()
}

export interface DirListingEntry {
  name: string
  type: 'file' | 'dir' | 'link'
  size: number
  mtime: number
  path: string
}

/**
 * Replace the cached listing for one directory: delete stale children (fixes deleted
 * remote files lingering forever), insert the fresh listing, and upsert the dir's own row.
 */
export function replaceDirListing(serverId: string, dirPath: string, entries: DirListingEntry[]): void {
  const instance = getDb()
  const { deleteChildren, insertEntry } = getStatements()

  const run = instance.transaction(() => {
    deleteChildren.run(serverId, dirPath)
    for (const entry of entries) {
      insertEntry.run({
        server_id: serverId,
        path: entry.path,
        name: entry.name,
        type: entry.type,
        size: entry.size || 0,
        mtime: entry.mtime || 0,
        parent_path: dirPath,
      })
    }
    insertEntry.run({
      server_id: serverId,
      path: dirPath,
      name: path.posix.basename(dirPath) || dirPath,
      type: 'dir',
      size: 0,
      mtime: Date.now(),
      parent_path: deriveParentPath(dirPath),
    })
  })
  run()
}

/** Rebuild the path-keyed map (with `children` arrays derived from parent_path). */
export function getTree(serverId: string): Record<string, RemoteCacheEntry> {
  const instance = getDb()
  const rows = instance
    .prepare('SELECT server_id, path, name, type, size, mtime, parent_path FROM entries WHERE server_id = ?')
    .all(serverId) as EntryRow[]

  const tree: Record<string, RemoteCacheEntry> = {}
  for (const row of rows) {
    tree[row.path] = {
      serverId: row.server_id,
      path: row.path,
      name: row.name,
      type: row.type,
      size: row.size,
      mtime: row.mtime,
    }
  }
  for (const row of rows) {
    if (!row.parent_path) continue
    const parent = tree[row.parent_path]
    if (!parent) continue
    if (!parent.children) parent.children = []
    parent.children.push(row.path)
  }
  return tree
}

/** Alias of getTree for compatibility with existing consumers (e.g. AI context). */
export function getCachedTreeForServer(serverId: string): Record<string, RemoteCacheEntry> {
  return getTree(serverId)
}

/** Minimal rows for the AI tree summary — avoids loading the full tree into memory. */
export function getSummaryEntries(serverId: string, limit: number): Array<Pick<FileEntry, 'type' | 'path'>> {
  const instance = getDb()
  const rows = instance
    .prepare('SELECT type, path FROM entries WHERE server_id = ? LIMIT ?')
    .all(serverId, limit) as Array<{ type: EntryRow['type']; path: string }>
  return rows.map(r => ({ type: r.type, path: r.path }))
}

/** Escape LIKE metacharacters (%, _, \) so the query is matched literally. */
function escapeLikeQuery(query: string): string {
  return query.replace(/[\\%_]/g, ch => `\\${ch}`)
}

export function search(serverId: string, query: string, limit = 500): RemoteCacheEntry[] {
  const instance = getDb()
  const escaped = escapeLikeQuery(query)
  const rows = instance
    .prepare(
      `SELECT server_id, path, name, type, size, mtime, parent_path FROM entries
       WHERE server_id = ? AND name LIKE ? ESCAPE '\\' COLLATE NOCASE
       LIMIT ?`
    )
    .all(serverId, `%${escaped}%`, limit) as EntryRow[]

  return rows.map(row => ({
    serverId: row.server_id,
    path: row.path,
    name: row.name,
    type: row.type,
    size: row.size,
    mtime: row.mtime,
  }))
}

/** Targeted or full cache clear. */
export function clear(serverId?: string): void {
  const instance = getDb()
  if (serverId) {
    instance.prepare('DELETE FROM entries WHERE server_id = ?').run(serverId)
  } else {
    instance.exec('DELETE FROM entries')
  }
}

/** Close the DB (call on app quit). */
export function close(): void {
  if (db) {
    db.close()
    db = null
    stmts = null
  }
}
