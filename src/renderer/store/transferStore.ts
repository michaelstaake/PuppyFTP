import { create } from 'zustand'
import type {
  TransferDirection,
  TransferHistoryStore,
  TransferJob,
  TransferProgressEvent,
} from '@shared/types'
import { fileNameFromPath } from '../lib/transferFormat'

const MAX_CONCURRENT = 2
const MAX_HISTORY = 200

/** Stable for this app process; used by the Transfers page Session filter. */
export const APP_TRANSFER_SESSION_ID = `ts_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

type EnqueueInput = {
  serverId: string
  serverName: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  bytesTotal?: number
}

type TransferStore = {
  transfers: TransferJob[]
  hydrated: boolean
  hydrate: (store: TransferHistoryStore) => void
  enqueue: (input: EnqueueInput) => string
  applyProgress: (event: TransferProgressEvent) => void
  clearCompleted: () => void
  /** Start next queued jobs up to concurrency limit. */
  processQueue: () => void
}

function newId(): string {
  return `xfer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

function schedulePersist(transfers: TransferJob[]): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const history = transfers
      .filter(t => t.status === 'completed' || t.status === 'failed')
      .slice(0, MAX_HISTORY)
    void window.electronAPI?.saveTransferHistory?.({ transfers: history })
  }, 400)
}

function normalizeHistoryJob(raw: TransferJob): TransferJob | null {
  if (!raw?.id || !raw.serverId) return null
  if (raw.status !== 'completed' && raw.status !== 'failed') return null
  return {
    ...raw,
    appSessionId: raw.appSessionId || 'legacy',
    speedBps: 0,
    percent: raw.status === 'completed' ? 100 : raw.percent ?? 0,
  }
}

async function runTransfer(job: TransferJob): Promise<void> {
  const api = window.electronAPI
  if (!api) {
    useTransferStore.getState().applyProgress({
      transferId: job.id,
      serverId: job.serverId,
      local: job.localPath,
      remote: job.remotePath,
      direction: job.direction,
      percent: 0,
      status: 'failed',
      error: 'Electron API unavailable',
    })
    return
  }

  const opts = { transferId: job.id, bytesTotal: job.bytesTotal || undefined }
  let ok = false
  try {
    if (job.direction === 'up') {
      ok = await api.uploadFile(job.serverId, job.localPath, job.remotePath, opts)
    } else {
      ok = await api.downloadFile(job.serverId, job.remotePath, job.localPath, opts)
    }
  } catch (e) {
    useTransferStore.getState().applyProgress({
      transferId: job.id,
      serverId: job.serverId,
      local: job.localPath,
      remote: job.remotePath,
      direction: job.direction,
      percent: 0,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    })
    useTransferStore.getState().processQueue()
    return
  }

  // Main process should emit completed/failed; ensure terminal state if it didn't.
  const current = useTransferStore.getState().transfers.find(t => t.id === job.id)
  if (current && (current.status === 'queued' || current.status === 'transferring')) {
    useTransferStore.getState().applyProgress({
      transferId: job.id,
      serverId: job.serverId,
      local: job.localPath,
      remote: job.remotePath,
      direction: job.direction,
      percent: ok ? 100 : current.percent,
      bytesTransferred: ok ? (current.bytesTotal || current.bytesTransferred) : current.bytesTransferred,
      bytesTotal: current.bytesTotal,
      status: ok ? 'completed' : 'failed',
      error: ok ? undefined : 'Transfer failed',
    })
  }

  useTransferStore.getState().processQueue()
}

export const useTransferStore = create<TransferStore>((set, get) => ({
  transfers: [],
  hydrated: false,

  hydrate: (store) => {
    if (get().hydrated) return
    const history = (store?.transfers || [])
      .map(normalizeHistoryJob)
      .filter((t): t is TransferJob => t != null)
      .slice(0, MAX_HISTORY)
    set({ transfers: history, hydrated: true })
  },

  enqueue: (input) => {
    const id = newId()
    const fileName =
      input.direction === 'up'
        ? fileNameFromPath(input.localPath)
        : fileNameFromPath(input.remotePath)

    const job: TransferJob = {
      id,
      serverId: input.serverId,
      serverName: input.serverName,
      direction: input.direction,
      localPath: input.localPath,
      remotePath: input.remotePath,
      fileName,
      status: 'queued',
      bytesTransferred: 0,
      bytesTotal: input.bytesTotal ?? 0,
      percent: 0,
      speedBps: 0,
      appSessionId: APP_TRANSFER_SESSION_ID,
      createdAt: Date.now(),
    }

    set(state => {
      const transfers = [job, ...state.transfers].slice(0, MAX_HISTORY)
      schedulePersist(transfers)
      return { transfers }
    })
    // Defer so callers can finish updating UI before work starts
    queueMicrotask(() => get().processQueue())
    return id
  },

  applyProgress: (event) => {
    set(state => {
      const transfers = state.transfers.map(job => {
        if (job.id !== event.transferId) return job

        const bytesTransferred = event.bytesTransferred ?? job.bytesTransferred
        const bytesTotal = event.bytesTotal ?? job.bytesTotal
        const percent =
          typeof event.percent === 'number'
            ? Math.min(100, Math.max(0, event.percent))
            : bytesTotal > 0
              ? Math.min(100, Math.round((bytesTransferred / bytesTotal) * 100))
              : job.percent

        let status = job.status
        if (event.status === 'transferring') status = 'transferring'
        if (event.status === 'completed') status = 'completed'
        if (event.status === 'failed') status = 'failed'
        else if (percent >= 100 && status === 'transferring') status = 'completed'

        const next: TransferJob = {
          ...job,
          bytesTransferred,
          bytesTotal,
          percent: status === 'completed' ? 100 : percent,
          speedBps:
            status === 'transferring'
              ? (event.speedBps ?? job.speedBps)
              : status === 'queued'
                ? 0
                : 0,
          status,
          error: event.error ?? (status === 'failed' ? job.error : undefined),
          startedAt:
            status === 'transferring' || status === 'completed' || status === 'failed'
              ? job.startedAt ?? Date.now()
              : job.startedAt,
          completedAt:
            status === 'completed' || status === 'failed'
              ? job.completedAt ?? Date.now()
              : undefined,
        }
        return next
      })
      schedulePersist(transfers)
      return { transfers }
    })
  },

  clearCompleted: () => {
    set(state => {
      const transfers = state.transfers.filter(
        t => t.status === 'queued' || t.status === 'transferring'
      )
      schedulePersist(transfers)
      return { transfers }
    })
  },

  processQueue: () => {
    const { transfers } = get()
    const transferring = transfers.filter(t => t.status === 'transferring')
    const busyServers = new Set(transferring.map(t => t.serverId))
    const slots = Math.max(0, MAX_CONCURRENT - transferring.length)
    if (slots === 0) return

    // Oldest queued first; at most one active transfer per server (shared remote client)
    const queued = [...transfers]
      .filter(t => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)

    const toStart: TransferJob[] = []
    for (const job of queued) {
      if (toStart.length >= slots) break
      if (busyServers.has(job.serverId)) continue
      busyServers.add(job.serverId)
      toStart.push(job)
    }

    if (toStart.length === 0) return

    const startIds = new Set(toStart.map(q => q.id))
    set(state => ({
      transfers: state.transfers.map(t =>
        startIds.has(t.id)
          ? {
              ...t,
              status: 'transferring' as const,
              startedAt: Date.now(),
              speedBps: 0,
            }
          : t
      ),
    }))

    for (const job of toStart) {
      const started = get().transfers.find(t => t.id === job.id)
      if (started) void runTransfer(started)
    }
  },
}))

export function getActiveTransferCount(transfers: TransferJob[]): number {
  return transfers.filter(t => t.status === 'queued' || t.status === 'transferring').length
}

export function getCurrentTransfers(transfers: TransferJob[]): TransferJob[] {
  return transfers
    .filter(t => t.status === 'queued' || t.status === 'transferring')
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'transferring' ? -1 : 1
      return a.createdAt - b.createdAt
    })
}
