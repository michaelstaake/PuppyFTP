import React from 'react'
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react'
import type { TransferJob } from '@shared/types'
import { formatBytes, formatSpeed } from '../../lib/transferFormat'

interface TransferJobRowProps {
  job: TransferJob
  /** denser layout for the TopBar dropdown */
  compact?: boolean
  showServer?: boolean
}

const TransferJobRow: React.FC<TransferJobRowProps> = ({
  job,
  compact = false,
  showServer = true,
}) => {
  const DirectionIcon = job.direction === 'up' ? ArrowUpFromLine : ArrowDownToLine
  const showProgress = job.status === 'transferring'
  const showQueued = job.status === 'queued'
  // Status badges only in the TopBar dropdown (Queued); the Transfers page
  // filters already communicate Completed / Failed / Current.
  const showStatusBadge = compact && job.status === 'queued'

  return (
    <div className={`border-b border-border last:border-b-0 ${compact ? 'px-3 py-2.5' : 'px-4 py-3'}`}>
      <div className="flex items-start gap-2.5 min-w-0">
        <div
          className={`mt-0.5 flex-shrink-0 rounded p-1 ${
            job.direction === 'up' ? 'bg-accent/10 text-accent' : 'bg-muted text-muted-foreground'
          }`}
          title={job.direction === 'up' ? 'Upload' : 'Download'}
        >
          <DirectionIcon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`truncate font-medium ${compact ? 'text-xs' : 'text-sm'}`} title={job.fileName}>
              {job.fileName}
            </span>
            {showStatusBadge && (
              <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                Queued
              </span>
            )}
          </div>
          {showServer && (
            <div className="text-[10px] text-muted-foreground truncate" title={job.serverName}>
              {job.serverName}
            </div>
          )}
          {showQueued && (
            <div className="text-[10px] text-muted-foreground">
              Waiting to start{job.bytesTotal > 0 ? ` · ${formatBytes(job.bytesTotal)}` : ''}
            </div>
          )}
          {showProgress && (
            <div className="space-y-1">
              <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-200"
                  style={{ width: `${Math.min(100, Math.max(0, job.percent))}%` }}
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span>
                  {job.bytesTotal > 0
                    ? `${formatBytes(job.bytesTransferred)} / ${formatBytes(job.bytesTotal)}`
                    : `${job.percent}%`}
                </span>
                <span className="text-accent tabular-nums">{formatSpeed(job.speedBps)}</span>
              </div>
            </div>
          )}
          {job.status === 'completed' && !compact && (
            <div className="text-[10px] text-muted-foreground">
              {job.bytesTotal > 0 ? formatBytes(job.bytesTotal) : 'Done'}
              {job.completedAt
                ? ` · ${new Date(job.completedAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}`
                : ''}
            </div>
          )}
          {job.status === 'failed' && (
            <div className="text-[10px] text-red-400 truncate" title={job.error}>
              {job.error || 'Transfer failed'}
            </div>
          )}
          {!compact && (
            <div className="text-[10px] text-muted-foreground/80 font-mono truncate" title={job.direction === 'up' ? job.remotePath : job.localPath}>
              {job.direction === 'up' ? `→ ${job.remotePath}` : `→ ${job.localPath}`}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default TransferJobRow
