import React, { useMemo, useState } from 'react'
import { ArrowLeft, ArrowLeftRight, Trash2 } from 'lucide-react'
import type {
  Server,
  TransferJob,
  TransferSessionFilter,
  TransferStatusFilter,
} from '@shared/types'
import { isTerminalProtocol } from '@shared/types'
import { APP_TRANSFER_SESSION_ID, useTransferStore } from '../../store/transferStore'
import TransferJobRow from './TransferJobRow'

interface TransfersPageProps {
  servers: Server[]
  onBack: () => void
}

const STATUS_FILTERS: { id: TransferStatusFilter; label: string }[] = [
  { id: 'current', label: 'Current' },
  { id: 'failed', label: 'Failed' },
  { id: 'completed', label: 'Completed' },
]

function matchesStatus(job: TransferJob, filter: TransferStatusFilter): boolean {
  if (filter === 'current') return job.status === 'queued' || job.status === 'transferring'
  if (filter === 'failed') return job.status === 'failed'
  return job.status === 'completed'
}

function matchesSession(job: TransferJob, filter: TransferSessionFilter): boolean {
  if (filter === 'all') return true
  return job.appSessionId === APP_TRANSFER_SESSION_ID
}

const TransfersPage: React.FC<TransfersPageProps> = ({ servers, onBack }) => {
  const transfers = useTransferStore(s => s.transfers)
  const clearCompleted = useTransferStore(s => s.clearCompleted)
  const [statusFilter, setStatusFilter] = useState<TransferStatusFilter>('current')
  const [serverFilter, setServerFilter] = useState<string>('all')
  const [sessionFilter, setSessionFilter] = useState<TransferSessionFilter>('this')

  const serverOptions = useMemo(() => {
    const fileServers = servers.filter(s => !isTerminalProtocol(s.protocol) && s.protocol !== 'rdp')
    const ids = new Set(transfers.map(t => t.serverId))
    const fromJobs = transfers.reduce<{ id: string; name: string }[]>((acc, t) => {
      if (!acc.some(s => s.id === t.serverId)) {
        acc.push({ id: t.serverId, name: t.serverName })
      }
      return acc
    }, [])
    // Prefer live server names when available
    return fromJobs.map(j => {
      const live = fileServers.find(s => s.id === j.id)
      return { id: j.id, name: live?.name || j.name }
    }).concat(
      fileServers
        .filter(s => !ids.has(s.id))
        .map(s => ({ id: s.id, name: s.name }))
    )
  }, [transfers, servers])

  const scoped = useMemo(() => {
    return transfers
      .filter(t => matchesSession(t, sessionFilter))
      .filter(t => serverFilter === 'all' || t.serverId === serverFilter)
  }, [transfers, sessionFilter, serverFilter])

  const filtered = useMemo(() => {
    return scoped
      .filter(t => matchesStatus(t, statusFilter))
      .sort((a, b) => {
        if (statusFilter === 'current') {
          if (a.status !== b.status) return a.status === 'transferring' ? -1 : 1
          return a.createdAt - b.createdAt
        }
        return (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt)
      })
  }, [scoped, statusFilter])

  const counts = useMemo(() => {
    return {
      current: scoped.filter(t => t.status === 'queued' || t.status === 'transferring').length,
      failed: scoped.filter(t => t.status === 'failed').length,
      completed: scoped.filter(t => t.status === 'completed').length,
    }
  }, [scoped])

  const emptyCopy =
    statusFilter === 'current'
      ? 'No files currently transferring or queued'
      : statusFilter === 'failed'
        ? 'No failed transfers'
        : 'No completed transfers'

  return (
    <div className="flex-1 flex flex-col bg-surface overflow-hidden">
      <div className="h-12 border-b border-border px-4 flex items-center justify-between bg-surface-elevated">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-accent" />
            Transfers
          </span>
        </div>
        {(statusFilter === 'completed' || counts.completed > 0) && (
          <button
            type="button"
            onClick={() => clearCompleted()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted/40"
            title="Clear completed from history"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear completed
          </button>
        )}
      </div>

      <div className="border-b border-border px-4 py-3 flex flex-wrap items-center gap-3 bg-surface-elevated/50">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">Status</span>
          {STATUS_FILTERS.map(f => {
            const count = counts[f.id]
            const active = statusFilter === f.id
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`px-2.5 py-1 rounded text-xs transition-colors ${
                  active
                    ? 'bg-accent/15 text-accent'
                    : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                }`}
              >
                {f.label}
                <span className={`ml-1.5 tabular-nums ${active ? 'text-accent/80' : 'text-muted-foreground/70'}`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        <div className="h-4 w-px bg-border hidden sm:block" />

        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">
            Server
          </span>
          <select
            value={serverFilter}
            onChange={e => setServerFilter(e.target.value)}
            className="text-xs bg-card border border-border rounded px-2 py-1 text-foreground max-w-[200px] outline-none focus:border-accent"
          >
            <option value="all">All servers</option>
            {serverOptions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="h-4 w-px bg-border hidden sm:block" />

        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">
            Session
          </span>
          <select
            value={sessionFilter}
            onChange={e => setSessionFilter(e.target.value as TransferSessionFilter)}
            className="text-xs bg-card border border-border rounded px-2 py-1 text-foreground outline-none focus:border-accent"
          >
            <option value="this">This session</option>
            <option value="all">All sessions</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-2 px-4">
            <ArrowLeftRight className="h-8 w-8 opacity-40" />
            <p className="text-sm">{emptyCopy}</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto w-full py-2">
            {filtered.map(job => (
              <TransferJobRow key={job.id} job={job} showServer={serverFilter === 'all'} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default TransfersPage
