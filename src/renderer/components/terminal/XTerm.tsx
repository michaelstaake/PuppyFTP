import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { Server } from '@shared/types'

interface XTermProps {
  server: Server
  active?: boolean
  onConnected?: () => void
  onConnectFailed?: () => void
  onDisconnected?: () => void
}

const XTerm: React.FC<XTermProps> = ({
  server,
  active = true,
  onConnected,
  onConnectFailed,
  onDisconnected,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const establishedRef = useRef(false)
  const onConnectedRef = useRef(onConnected)
  const onConnectFailedRef = useRef(onConnectFailed)
  const onDisconnectedRef = useRef(onDisconnected)
  onConnectedRef.current = onConnected
  onConnectFailedRef.current = onConnectFailed
  onDisconnectedRef.current = onDisconnected

  useEffect(() => {
    if (!containerRef.current || termRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0a0a0f',
        foreground: '#e0e0e0',
        cursor: '#f97316',
        selectionBackground: '#3f3f46',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
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
        const sessionId = await window.electronAPI.createTerminal(server)
        sessionIdRef.current = sessionId
        establishedRef.current = true
        onConnectedRef.current?.()

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

        const cleanup = () => {
          window.removeEventListener('resize', onResize)
          unsubData()
          unsubExit()
          if (sessionIdRef.current) {
            window.electronAPI.closeTerminal(sessionIdRef.current).catch(() => {})
            sessionIdRef.current = null
          }
          if (termRef.current) {
            termRef.current.dispose()
            termRef.current = null
          }
          fitAddonRef.current = null
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
        }
      } catch { /* ignore */ }
    })
  }, [active])

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden"
      style={{ background: '#0a0a0f' }}
    />
  )
}

export default XTerm
