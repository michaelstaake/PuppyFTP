import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import {
  Server,
  type FileFontStyle,
  DEFAULT_TERMINAL_SETTINGS,
  terminalFontFamily,
} from '@shared/types'

export interface XTermHandle {
  /** Call before unmounting so cleanup does not end the SSH session. */
  prepareDetach: () => void
  /** Undo prepareDetach if pop-out did not proceed. */
  cancelDetach: () => void
  getSessionId: () => string | null
  /** Serialize visible buffer + scrollback for handoff to another window. */
  serialize: () => string
  /** Selected terminal text, or empty string if none. */
  getSelection: () => string
  hasSelection: () => boolean
  /** Paste text into the terminal (sends to remote as typed input). */
  paste: (text: string) => void
  /** Bounding rect of the terminal element for screenshots (viewport coords). */
  getBoundingClientRect: () => DOMRect | null
  focus: () => void
}

interface XTermProps {
  server: Server
  active?: boolean
  /** Attach to an existing main-process session instead of creating a new one. */
  existingSessionId?: string | null
  /** When true, unmount disposes the UI but leaves the SSH session running. */
  detachOnUnmount?: boolean
  fontStyle?: FileFontStyle
  fontSize?: number
  onConnected?: () => void
  onConnectFailed?: () => void
  onDisconnected?: () => void
}

const XTerm = forwardRef<XTermHandle, XTermProps>(function XTerm(
  {
    server,
    active = true,
    existingSessionId = null,
    detachOnUnmount = false,
    fontStyle = DEFAULT_TERMINAL_SETTINGS.fontStyle,
    fontSize = DEFAULT_TERMINAL_SETTINGS.fontSize,
    onConnected,
    onConnectFailed,
    onDisconnected,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const serializeAddonRef = useRef<SerializeAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const establishedRef = useRef(false)
  const detachRef = useRef(false)
  const detachOnUnmountRef = useRef(detachOnUnmount)
  detachOnUnmountRef.current = detachOnUnmount
  const onConnectedRef = useRef(onConnected)
  const onConnectFailedRef = useRef(onConnectFailed)
  const onDisconnectedRef = useRef(onDisconnected)
  const activeRef = useRef(active)
  onConnectedRef.current = onConnected
  onConnectFailedRef.current = onConnectFailed
  onDisconnectedRef.current = onDisconnected
  activeRef.current = active

  const focusTerminal = () => {
    // Defer so focus wins over whatever stole it during connect (sidebar click, overlay, etc.).
    requestAnimationFrame(() => {
      termRef.current?.focus()
    })
  }

  useImperativeHandle(ref, () => ({
    prepareDetach: () => {
      detachRef.current = true
    },
    cancelDetach: () => {
      detachRef.current = false
    },
    getSessionId: () => sessionIdRef.current,
    serialize: () => {
      try {
        return serializeAddonRef.current?.serialize() ?? ''
      } catch {
        return ''
      }
    },
    getSelection: () => termRef.current?.getSelection() ?? '',
    hasSelection: () => !!termRef.current?.hasSelection(),
    paste: (text: string) => {
      const term = termRef.current
      if (!term || !text) return
      term.paste(text)
    },
    getBoundingClientRect: () => containerRef.current?.getBoundingClientRect() ?? null,
    focus: focusTerminal,
  }))

  useEffect(() => {
    if (!containerRef.current || termRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: terminalFontFamily(fontStyle),
      scrollback: 5000,
      theme: {
        background: '#0a0a0f',
        foreground: '#e0e0e0',
        cursor: '#f97316',
        selectionBackground: '#3f3f46',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const serializeAddon = new SerializeAddon()
    fitAddonRef.current = fitAddon
    serializeAddonRef.current = serializeAddon
    term.loadAddon(fitAddon)
    term.loadAddon(serializeAddon)
    term.loadAddon(new WebLinksAddon())

    term.open(containerRef.current)
    requestAnimationFrame(() => fitAddon.fit())

    termRef.current = term

    const initTerminal = async () => {
      try {
        if (!window.electronAPI?.createTerminal) {
          throw new Error(
            'Electron bridge unavailable (preload failed to load). Restart the app with npm run dev.'
          )
        }

        let sessionId: string
        let restoredScrollback = ''
        if (existingSessionId) {
          const claimed = await window.electronAPI.claimTerminal(existingSessionId)
          if (!claimed?.success) {
            throw new Error('Terminal session is no longer available')
          }
          sessionId = existingSessionId
          restoredScrollback = claimed.scrollback || ''
        } else {
          sessionId = await window.electronAPI.createTerminal(server)
        }

        if (restoredScrollback && termRef.current) {
          await new Promise<void>(resolve => {
            termRef.current?.write(restoredScrollback, () => resolve())
          })
        }

        sessionIdRef.current = sessionId
        establishedRef.current = true
        onConnectedRef.current?.()
        if (activeRef.current) focusTerminal()

        const handleData = (sid: string, data: string) => {
          if (sid === sessionId && termRef.current) {
            termRef.current.write(data)
          }
        }
        const unsubData = window.electronAPI.onTerminalData(handleData)

        const handleExit = (sid: string) => {
          if (sid === sessionId && termRef.current) {
            termRef.current.write('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n')
            sessionIdRef.current = null
            if (establishedRef.current) {
              onDisconnectedRef.current?.()
            } else {
              onConnectFailedRef.current?.()
            }
          }
        }
        const unsubExit = window.electronAPI.onTerminalExit(handleExit)

        const onData = (data: string) => {
          if (sessionIdRef.current) {
            window.electronAPI.sendTerminalData(sessionIdRef.current, data).catch(() => {})
          }
        }
        term.onData(onData)

        const onResize = () => {
          try {
            fitAddon.fit()
            const dims = termRef.current
            if (dims && sessionIdRef.current) {
              window.electronAPI.resizeTerminal(sessionIdRef.current, dims.cols, dims.rows).catch(() => {})
            }
          } catch { /* ignore resize errors */ }
        }

        window.addEventListener('resize', onResize)
        setTimeout(onResize, 150)

        const ro =
          typeof ResizeObserver !== 'undefined' && containerRef.current
            ? new ResizeObserver(() => onResize())
            : null
        if (ro && containerRef.current) ro.observe(containerRef.current)

        const cleanup = () => {
          window.removeEventListener('resize', onResize)
          ro?.disconnect()
          unsubData()
          unsubExit()
          if (sessionIdRef.current) {
            if (!detachRef.current && !detachOnUnmountRef.current) {
              window.electronAPI.closeTerminal(sessionIdRef.current).catch(() => {})
            }
            sessionIdRef.current = null
          }
          if (termRef.current) {
            termRef.current.dispose()
            termRef.current = null
          }
          fitAddonRef.current = null
          serializeAddonRef.current = null
        }
        cleanupRef.current = cleanup
      } catch (err: unknown) {
        if (termRef.current) {
          termRef.current.write(`\r\n\x1b[31mFailed to connect: ${String(err)}\x1b[0m\r\n`)
        }
        establishedRef.current = false
        onConnectFailedRef.current?.()
      }
    }

    void initTerminal()

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
    }
  }, [server?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit()
        const term = termRef.current
        if (term && sessionIdRef.current) {
          window.electronAPI.resizeTerminal(sessionIdRef.current, term.cols, term.rows).catch(() => {})
          term.focus()
        }
      } catch { /* ignore */ }
    })
  }, [active])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const nextFamily = terminalFontFamily(fontStyle)
    const nextSize = fontSize
    if (term.options.fontFamily === nextFamily && term.options.fontSize === nextSize) return
    term.options.fontFamily = nextFamily
    term.options.fontSize = nextSize
    requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit()
        if (sessionIdRef.current) {
          window.electronAPI.resizeTerminal(sessionIdRef.current, term.cols, term.rows).catch(() => {})
        }
      } catch { /* ignore */ }
    })
  }, [fontStyle, fontSize])

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden"
      style={{ background: '#0a0a0f' }}
    />
  )
})

export default XTerm
