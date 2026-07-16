import React, { useEffect, useRef } from 'react'
import { ClipboardCopy, ClipboardPaste, Camera } from 'lucide-react'
import type { XTermHandle } from './XTerm'

export type TerminalMenuAnchor = { x: number; y: number }

interface TerminalActionsMenuProps {
  open: boolean
  anchor: TerminalMenuAnchor | null
  terminal: XTermHandle | null
  onClose: () => void
  /** Clicks on this element should not auto-close (e.g. the toggle button). */
  ignoreCloseRef?: { current: HTMLElement | null }
}

const TerminalActionsMenu: React.FC<TerminalActionsMenuProps> = ({
  open,
  anchor,
  terminal,
  onClose,
  ignoreCloseRef,
}) => {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (ignoreCloseRef?.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose, ignoreCloseRef])

  if (!open || !anchor) return null

  const handleCopy = async () => {
    const text = terminal?.getSelection() ?? ''
    if (text) {
      await window.electronAPI?.writeClipboardText?.(text)
    }
    onClose()
  }

  const handlePaste = async () => {
    const text = (await window.electronAPI?.readClipboardText?.()) ?? ''
    if (text) {
      terminal?.paste(text)
      terminal?.focus()
    }
    onClose()
  }

  const handleScreenshot = async () => {
    const rect = terminal?.getBoundingClientRect()
    const payload = rect
      ? {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      : undefined
    await window.electronAPI?.captureRectToClipboard?.(payload)
    onClose()
  }

  const hasSelection = !!terminal?.hasSelection()

  return (
    <div
      ref={menuRef}
      className="fixed z-[60] min-w-[160px] rounded-md border border-border bg-card py-1 shadow-lg text-sm"
      style={{ left: anchor.x, top: anchor.y }}
      role="menu"
    >
      <button
        type="button"
        role="menuitem"
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left disabled:opacity-40 disabled:pointer-events-none"
        disabled={!hasSelection}
        onClick={() => void handleCopy()}
      >
        <ClipboardCopy className="h-3.5 w-3.5" />
        Copy
      </button>
      <button
        type="button"
        role="menuitem"
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left"
        onClick={() => void handlePaste()}
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
        Paste
      </button>
      <button
        type="button"
        role="menuitem"
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left"
        onClick={() => void handleScreenshot()}
      >
        <Camera className="h-3.5 w-3.5" />
        Screenshot
      </button>
    </div>
  )
}

export default TerminalActionsMenu
