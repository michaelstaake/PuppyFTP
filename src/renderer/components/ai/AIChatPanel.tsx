import React from 'react'
import { Bot, History, MessageCircle, Plus, Send, Terminal, X } from 'lucide-react'
import type { AIChatMessage, AICommandApprovalRequest, AISession } from '@shared/types'
import { formatTokenCount } from '../../lib/aiContext'

export type { AIChatMessage }

interface AIChatPanelProps {
  open: boolean
  onClose: () => void
  messages: AIChatMessage[]
  streaming: boolean
  onSend: (query: string) => void
  serverName?: string
  pendingApproval?: AICommandApprovalRequest | null
  onRespondApproval?: (requestId: string, approved: boolean) => void
  /** Sessions for the current server (newest first preferred). */
  sessions: AISession[]
  currentSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onNewSession: () => void
  readOnly?: boolean
  contextUsed: number
  contextLength: number
}

function ContextUsageRing({ used, total }: { used: number; total: number }) {
  const safeTotal = Math.max(1, total)
  const pct = Math.min(1, Math.max(0, used / safeTotal))
  const size = 22
  const stroke = 2.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c * (1 - pct)
  const hot = pct >= 0.9
  const warm = pct >= 0.7

  return (
    <div
      className="relative shrink-0"
      title={`Context: ${used.toLocaleString()} / ${total.toLocaleString()} tokens`}
      aria-label={`Context usage ${Math.round(pct * 100)} percent`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-muted/40"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={hot ? 'text-red-500' : warm ? 'text-amber-500' : 'text-accent'}
        />
      </svg>
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[8px] font-medium tabular-nums text-muted-foreground">
        {formatTokenCount(used)}
      </span>
    </div>
  )
}

function sessionLabel(session: AISession): string {
  const title = session.title?.trim() || 'New chat'
  return title.length > 48 ? `${title.slice(0, 45)}…` : title
}

function formatSessionTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

const AIChatPanel: React.FC<AIChatPanelProps> = ({
  open,
  onClose,
  messages,
  streaming,
  onSend,
  serverName,
  pendingApproval,
  onRespondApproval,
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
  readOnly = false,
  contextUsed,
  contextLength,
}) => {
  const [draft, setDraft] = React.useState('')
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const historyRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (open && !pendingApproval && !readOnly) {
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open, pendingApproval, readOnly, currentSessionId])

  React.useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, streaming, open, pendingApproval])

  React.useEffect(() => {
    setHistoryOpen(false)
    setDraft('')
  }, [currentSessionId])

  React.useEffect(() => {
    if (!historyOpen) return
    const onDoc = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [historyOpen])

  const sortedSessions = React.useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions]
  )

  if (!open) return null

  const canSend = !readOnly && !streaming && !pendingApproval

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const q = draft.trim()
    if (!q || !canSend) return
    onSend(q)
    setDraft('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const phaseLabel = (phase?: AIChatMessage['commandPhase']) => {
    switch (phase) {
      case 'running':
        return 'Running'
      case 'done':
        return 'Ran'
      case 'denied':
        return 'Denied'
      case 'error':
        return 'Failed'
      default:
        return 'Command'
    }
  }

  return (
    <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-surface-elevated shadow-xl">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="text-sm font-medium leading-tight">Ask AI</div>
            {serverName && (
              <div className="truncate text-xs text-muted-foreground">{serverName}</div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="relative" ref={historyRef}>
            <button
              type="button"
              onClick={() => setHistoryOpen(o => !o)}
              className={`rounded-md p-1.5 ${
                historyOpen
                  ? 'bg-accent/15 text-accent'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              title="Previous sessions"
              aria-label="Previous sessions"
              aria-expanded={historyOpen}
            >
              <History className="h-4 w-4" />
            </button>
            {historyOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-lg">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="text-xs font-medium text-muted-foreground">Sessions</span>
                  <button
                    type="button"
                    onClick={() => {
                      onNewSession()
                      setHistoryOpen(false)
                    }}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-accent hover:bg-accent/10"
                  >
                    <Plus className="h-3 w-3" />
                    New
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto py-1">
                  {sortedSessions.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                      No sessions yet
                    </p>
                  ) : (
                    sortedSessions.map(session => {
                      const selected = session.id === currentSessionId
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => {
                            onSelectSession(session.id)
                            setHistoryOpen(false)
                          }}
                          className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-muted ${
                            selected ? 'bg-accent/10' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm text-foreground">
                              {sessionLabel(session)}
                            </span>
                            {session.status === 'active' && (
                              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                                Active
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-muted-foreground">
                            {formatSessionTime(session.updatedAt)}
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onNewSession}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="New chat"
            aria-label="New chat"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Close chat"
            aria-label="Close chat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {readOnly && messages.length > 0 && (
        <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-1.5 text-center text-[11px] text-muted-foreground">
          This session has ended and is read-only
        </div>
      )}

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !pendingApproval && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-muted-foreground">
            <MessageCircle className="h-8 w-8 opacity-40" />
            <p className="text-sm">
              {readOnly
                ? 'This session has ended. Start a new chat to ask about this server.'
                : 'Ask about the current server — paths, permissions, transfers, or SSH commands.'}
            </p>
            {readOnly && (
              <button
                type="button"
                onClick={onNewSession}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
              >
                <Plus className="h-3.5 w-3.5" />
                New chat
              </button>
            )}
          </div>
        )}

        {messages.map(msg => {
          if (msg.kind === 'command-status') {
            return (
              <div key={msg.id} className="flex justify-start">
                <div className="max-w-[90%] rounded-lg border border-border bg-muted/60 px-3 py-2 text-sm">
                  <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Terminal className="h-3.5 w-3.5" />
                    {phaseLabel(msg.commandPhase)}
                  </div>
                  <code className="block whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                    {msg.content}
                  </code>
                </div>
              </div>
            )
          }

          return (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-muted text-foreground'
                }`}
              >
                {msg.content}
                {streaming &&
                  msg.role === 'assistant' &&
                  msg.id === messages[messages.length - 1]?.id &&
                  msg.content === '' && (
                    <span className="text-muted-foreground">Thinking…</span>
                  )}
                {streaming &&
                  msg.role === 'assistant' &&
                  msg.id === messages[messages.length - 1]?.id &&
                  msg.content !== '' && (
                    <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" />
                  )}
              </div>
            </div>
          )
        })}

        {pendingApproval && !readOnly && (
          <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-accent">
              <Terminal className="h-3.5 w-3.5" />
              Allow AI to run this command?
            </div>
            <code className="mb-3 block whitespace-pre-wrap break-all rounded border border-border bg-background px-2 py-1.5 font-mono text-xs">
              {pendingApproval.command}
            </code>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
                onClick={() => onRespondApproval?.(pendingApproval.requestId, true)}
              >
                Run
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onRespondApproval?.(pendingApproval.requestId, false)}
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>

      {readOnly ? (
        <div className="shrink-0 border-t border-border px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">
              Read-only history — start a new chat to continue
            </p>
            <button
              type="button"
              onClick={onNewSession}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
            >
              <Plus className="h-3.5 w-3.5" />
              New chat
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="shrink-0 border-t border-border p-3">
          <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-3 py-2 focus-within:border-accent">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!canSend}
              rows={2}
              placeholder="Ask about this server…"
              className="max-h-32 min-h-[2.75rem] flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed focus:outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!draft.trim() || !canSend}
              className="mb-0.5 shrink-0 rounded-md p-2 text-accent hover:bg-accent/10 disabled:opacity-40"
              title="Send"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Enter to send · Shift+Enter for new line
            </p>
            <ContextUsageRing used={contextUsed} total={contextLength} />
          </div>
        </form>
      )}
    </div>
  )
}

export default AIChatPanel
