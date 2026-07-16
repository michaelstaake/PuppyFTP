import React, { useEffect, useRef } from 'react'
import { ArrowLeftRight, ChevronRight } from 'lucide-react'
import {
  getActiveTransferCount,
  getCurrentTransfers,
  useTransferStore,
} from '../../store/transferStore'
import TransferJobRow from './TransferJobRow'

interface TransferQueuePanelProps {
  open: boolean
  onToggle: () => void
  onClose: () => void
  onOpenTransfersPage: () => void
}

const TransferQueuePanel: React.FC<TransferQueuePanelProps> = ({
  open,
  onToggle,
  onClose,
  onOpenTransfersPage,
}) => {
  const transfers = useTransferStore(s => s.transfers)
  const current = getCurrentTransfers(transfers)
  const activeCount = getActiveTransferCount(transfers)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, onClose])

  return (
    <div className="relative no-drag flex-shrink-0" ref={wrapRef}>
      <button
        type="button"
        onClick={onToggle}
        className={`relative p-2 rounded hover:bg-accent/10 no-drag ${
          open ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground'
        }`}
        title="Transfers"
        aria-label="Transfers"
        aria-expanded={open}
      >
        <ArrowLeftRight className="h-4 w-4" />
        {activeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 rounded-full bg-accent text-[9px] font-semibold text-white flex items-center justify-center leading-none">
            {activeCount > 99 ? '99+' : activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">File transfers</span>
            <span className="text-[10px] text-muted-foreground">
              {activeCount === 0
                ? 'Idle'
                : `${activeCount} active`}
            </span>
          </div>

          <div className="max-h-72 overflow-y-auto">
            {current.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                No files transferring
              </div>
            ) : (
              current.map(job => <TransferJobRow key={job.id} job={job} compact />)
            )}
          </div>

          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => {
                onClose()
                onOpenTransfersPage()
              }}
              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-muted-foreground hover:bg-accent/10 hover:text-foreground transition-colors"
            >
              <span>Go to Transfers page</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default TransferQueuePanel
