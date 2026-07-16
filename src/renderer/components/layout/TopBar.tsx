import React, { useState, useCallback } from 'react'
import { Settings } from 'lucide-react'
import TransferQueuePanel from '../transfers/TransferQueuePanel'

interface TopBarProps {
  onOpenSettings: () => void
  onOpenTransfers: () => void
}

const TopBar: React.FC<TopBarProps> = ({ onOpenSettings, onOpenTransfers }) => {
  const [queueOpen, setQueueOpen] = useState(false)
  // titleBarOverlay puts window controls on the right
  const barStyle: React.CSSProperties = { paddingLeft: 16, paddingRight: 148 }

  const closeQueue = useCallback(() => setQueueOpen(false), [])

  return (
    <div
      className="h-12 bg-surface-elevated border-b border-border flex items-center text-sm select-none top-bar relative"
      style={barStyle}
    >
      <div className="flex items-center gap-2 font-semibold text-foreground flex-shrink-0">
        <img
          src="./logo-icon.png"
          alt="PuppyFTP"
          className="h-6 w-6 object-contain"
        />
        <span>PuppyFTP</span>
      </div>

      <div className="flex-1 min-w-0" />

      <div className="flex items-center gap-0.5 flex-shrink-0">
        <TransferQueuePanel
          open={queueOpen}
          onToggle={() => setQueueOpen(o => !o)}
          onClose={closeQueue}
          onOpenTransfersPage={onOpenTransfers}
        />

        <button
          onClick={() => {
            setQueueOpen(false)
            onOpenSettings()
          }}
          className="p-2 rounded hover:bg-accent/10 text-muted-foreground hover:text-foreground no-drag flex-shrink-0"
          title="Settings"
          aria-label="Settings"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export default TopBar
