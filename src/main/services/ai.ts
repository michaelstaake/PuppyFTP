import OpenAI from 'openai'
import type { ClientOptions } from 'openai'
import { Agent, fetch as undiciFetch } from 'undici'
import type { AppSettings, ConnectionStatus, Protocol, Server } from '../../shared/types'
import { DEFAULT_CONTEXT_LENGTH } from '../../shared/types'

export interface AIServerContext {
  id: string
  name: string
  protocol: Protocol
  host: string
  port: number
  username?: string
  lastKnownOs?: string
  notes?: string
}

export interface AIAskContext {
  server?: AIServerContext
  remoteCwd?: string
  treeSummary?: string
  /** Live UI session status for the selected server. */
  connectionStatus?: ConnectionStatus
}

export interface AIConfig {
  enabled: boolean
  baseURL: string
  model: string
  apiKey: string
  allowRunCommands?: boolean
  askBeforeRunningCommands?: boolean
  contextLength?: number
}

export interface AIHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Rough token estimate (~4 chars/token). Shared with renderer usage UI. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** Single source of truth lives in shared/types; re-exported here for existing callers. */
export { DEFAULT_CONTEXT_LENGTH }
const MIN_CONTEXT_LENGTH = 1024
const MAX_CONTEXT_LENGTH = 1_000_000

export function normalizeContextLength(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_CONTEXT_LENGTH
  return Math.min(MAX_CONTEXT_LENGTH, Math.max(MIN_CONTEXT_LENGTH, Math.round(n)))
}

export interface AIRunCommandResult {
  output: string
  exitCode: number | null
  error?: string
}

export interface AIAskHooks {
  /** Execute a shell command on the current SSH server. */
  runCommand?: (command: string) => Promise<AIRunCommandResult>
  /** Notify UI that a command is about to run / finished (optional). */
  onCommandStatus?: (status: { command: string; phase: 'running' | 'done' | 'denied' | 'error'; detail?: string }) => void
}

const MAX_TREE_ENTRIES = 500
const MAX_TREE_CHARS = 48_000
const MAX_COMMAND_OUTPUT_CHARS = 32_000
const MAX_TOOL_ROUNDS = 8

const RUN_SSH_COMMAND_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'run_ssh_command',
    description:
      'Run a shell command on the current SSH server and return stdout/stderr. ' +
      'Use only when the user asks you to run something, inspect the live system, or when cache context is insufficient. ' +
      'Prefer non-destructive commands. Do not use for passwords or secrets.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute on the remote SSH host',
        },
      },
      required: ['command'],
    },
  },
}

const insecureUndiciDispatcher = new Agent({
  connect: { rejectUnauthorized: false },
})

function isLocalHttps(baseURL: string): boolean {
  try {
    const u = new URL(baseURL)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

/** Local HTTPS panels often use self-signed certs — bypass TLS verify via undici. */
function localHttpsFetchOptions(baseURL: string): Partial<ClientOptions> {
  if (!isLocalHttps(baseURL)) return {}
  return {
    // undici fetch is API-compatible; cast keeps OpenAI ClientOptions happy across Node typings
    fetch: undiciFetch as unknown as ClientOptions['fetch'],
    fetchOptions: { dispatcher: insecureUndiciDispatcher } as ClientOptions['fetchOptions'],
  }
}

/** Strip credentials — never send passwords or key material to the model. */
export function sanitizeServerForAI(server: Server): AIServerContext {
  return {
    id: server.id,
    name: server.name,
    protocol: server.protocol,
    host: server.host,
    port: server.port,
    username: server.username,
    lastKnownOs: server.lastKnownOs,
    notes: server.notes,
  }
}

export function buildTreeSummary(
  tree: Record<string, { name?: string; type?: string; path?: string; size?: number }> | null | undefined
): string {
  if (!tree || Object.keys(tree).length === 0) {
    return (
      'No cached remote filesystem tree is available yet. ' +
      'If the user asks about file locations, suggest they use "Explore full tree" on the remote pane first.'
    )
  }

  const entries = Object.values(tree)
  const lines: string[] = []
  let chars = 0

  for (let i = 0; i < entries.length && i < MAX_TREE_ENTRIES; i++) {
    const e = entries[i]
    const kind = e.type === 'dir' ? 'dir' : e.type === 'link' ? 'link' : 'file'
    const line = `${kind}\t${e.path || e.name || ''}`
    if (chars + line.length + 1 > MAX_TREE_CHARS) break
    lines.push(line)
    chars += line.length + 1
  }

  const omitted = entries.length - lines.length
  const header = `Cached remote filesystem (${entries.length} entries${omitted > 0 ? `, showing ${lines.length}` : ''}):`
  return `${header}\n${lines.join('\n')}${omitted > 0 ? `\n...and ${omitted} more entries not shown` : ''}`
}

/** Same as buildTreeSummary but for a flat row array (e.g. a DB query result) instead of a keyed tree. */
export function buildTreeSummaryFromRows(rows: Array<{ type?: string; path?: string }>): string {
  if (!rows || rows.length === 0) {
    return (
      'No cached remote filesystem tree is available yet. ' +
      'If the user asks about file locations, suggest they use "Explore full tree" on the remote pane first.'
    )
  }

  const lines: string[] = []
  let chars = 0

  for (let i = 0; i < rows.length && i < MAX_TREE_ENTRIES; i++) {
    const row = rows[i]
    const kind = row.type === 'dir' ? 'dir' : row.type === 'link' ? 'link' : 'file'
    const line = `${kind}\t${row.path || ''}`
    if (chars + line.length + 1 > MAX_TREE_CHARS) break
    lines.push(line)
    chars += line.length + 1
  }

  const omitted = rows.length - lines.length
  const header = `Cached remote filesystem (${rows.length} entries${omitted > 0 ? `, showing ${lines.length}` : ''}):`
  return `${header}\n${lines.join('\n')}${omitted > 0 ? `\n...and ${omitted} more entries not shown` : ''}`
}

export function buildSystemPrompt(context?: AIAskContext, options?: { allowRunCommands?: boolean }): string {
  const server = context?.server
  const connectionStatus: ConnectionStatus = context?.connectionStatus ?? 'disconnected'
  const isLive = connectionStatus === 'connected'
  const canRun =
    options?.allowRunCommands === true &&
    server?.protocol === 'ssh' &&
    isLive

  const parts = [
    'You are PuppyFTP Ask AI — a helpful assistant inside an FTP/SFTP/SSH desktop client.',
    'Answer questions about the currently selected remote server and its files.',
    'Be concise and practical. Prefer exact paths when you know them from the cache.',
    'Never ask for, invent, or discuss passwords, private keys, API keys, or passphrases.',
    'If information is missing (no cache, unknown OS), say so and suggest what the user can do in PuppyFTP.',
    'Always respect the Connection status below — do not claim the user is connected unless status is "connected".',
  ]

  if (canRun) {
    parts.push(
      '',
      'You can run shell commands on this SSH server using the run_ssh_command tool.',
      'Use it when the user asks you to run a command, check live system state, or when the cache is not enough.',
      'Explain briefly what you ran and summarize the output. Prefer safe, read-only commands unless the user clearly asks otherwise.'
    )
  } else if (server?.protocol === 'ssh' && !isLive) {
    parts.push(
      '',
      'You cannot run remote shell commands right now because there is no live SSH connection.',
      connectionStatus === 'lost'
        ? 'The server connection was lost. Tell the user to use "Attempt to reconnect" (or Close connection) in the main panel.'
        : connectionStatus === 'failed'
          ? 'Connecting failed. Tell the user to use "Attempt to connect again" in the main panel.'
          : connectionStatus === 'connecting'
            ? 'A connection attempt is in progress.'
            : 'The user is not connected. Tell them to connect from the main panel first.'
    )
  } else if (server?.protocol === 'ssh') {
    parts.push(
      '',
      'Command execution is disabled. If the user asks you to run a command, explain they can enable "Allow AI to run commands" in Settings > AI.'
    )
  } else if (server) {
    parts.push(
      '',
      'This connection is not an SSH shell session. You cannot run remote shell commands here — only answer from context and cache.'
    )
  }

  if (server) {
    const statusLabel =
      connectionStatus === 'connected'
        ? 'connected (live session)'
        : connectionStatus === 'connecting'
          ? 'connecting (attempt in progress; not connected yet)'
          : connectionStatus === 'failed'
            ? 'failed (unable to connect)'
            : connectionStatus === 'lost'
              ? 'lost (session dropped; not currently connected)'
              : 'disconnected (not connected)'
    parts.push(
      '',
      'Current server context:',
      `- Name: ${server.name}`,
      `- Protocol: ${server.protocol}`,
      `- Host: ${server.host}:${server.port}`,
      `- Connection status: ${statusLabel}`,
      server.username ? `- Username: ${server.username}` : '',
      server.lastKnownOs ? `- OS suggestion: ${server.lastKnownOs}` : '',
      server.notes ? `- Notes: ${server.notes}` : '',
      context?.remoteCwd ? `- Current remote directory: ${context.remoteCwd}` : ''
    )
  } else {
    parts.push('', 'No server is selected. Answer generally about PuppyFTP usage.')
  }

  if (context?.treeSummary) {
    parts.push('', context.treeSummary)
  }

  return parts.filter(Boolean).join('\n')
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

function createClient(ai: AIConfig): OpenAI {
  const baseURL = normalizeBaseURL(ai.baseURL)
  if (!baseURL) throw new Error('No base URL. Configure in Settings > AI')
  if (!ai.model?.trim()) throw new Error('No model. Configure in Settings > AI')

  return new OpenAI({
    apiKey: ai.apiKey?.trim() || 'no-key',
    baseURL,
    timeout: 120_000,
    // Local HTTPS panels (LmPanel, etc.) often use self-signed certs
    ...localHttpsFetchOptions(baseURL),
  })
}

function friendlyError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err || 'unknown error')
  const e = err as {
    status?: number
    code?: string
    message?: string
    error?: { message?: string }
    cause?: { code?: string; message?: string }
  }
  if (e.status === 401 || e.status === 403) {
    return 'AI authentication failed. Check your API key in Settings > AI'
  }
  const msg = e.error?.message || e.message || e.cause?.message || 'unknown error'
  const code = e.code || e.cause?.code || ''
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(msg)) {
    return `Could not reach AI endpoint (DNS). Check Base URL. (${msg})`
  }
  if (code === 'ECONNREFUSED') {
    return `AI endpoint refused connection. Is the local server running? (${msg})`
  }
  if (/certificate|SSL|TLS|self.signed/i.test(msg)) {
    return `TLS/certificate error talking to AI endpoint. (${msg})`
  }
  return msg
}

function isAuthError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  return status === 401 || status === 403
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_COMMAND_OUTPUT_CHARS) return text
  const omitted = text.length - MAX_COMMAND_OUTPUT_CHARS
  return `${text.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n…[truncated ${omitted} characters]`
}

function parseToolCommand(argsJson: string | undefined): string {
  try {
    const parsed = JSON.parse(argsJson || '{}') as { command?: unknown }
    const command = typeof parsed.command === 'string' ? parsed.command.trim() : ''
    return command
  } catch {
    return ''
  }
}

export async function listAIModels(ai: Pick<AIConfig, 'baseURL' | 'apiKey'>): Promise<string[]> {
  const baseURL = normalizeBaseURL(ai.baseURL)
  if (!baseURL) return []

  const client = new OpenAI({
    apiKey: ai.apiKey?.trim() || 'no-key',
    baseURL,
    timeout: 30_000,
    ...localHttpsFetchOptions(baseURL),
  })

  const list = await client.models.list()
  const ids: string[] = []
  for await (const model of list) {
    if (model?.id) ids.push(model.id)
  }
  return ids.sort((a, b) => a.localeCompare(b))
}

async function streamCompletion(
  client: OpenAI,
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  onChunk: (chunk: string) => void
): Promise<string> {
  try {
    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
    })

    let full = ''
    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content
      if (delta) {
        full += delta
        onChunk(delta)
      }
    }
    if (full.trim()) return full
  } catch (streamErr) {
    if (isAuthError(streamErr)) throw new Error(friendlyError(streamErr))
  }

  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      stream: false,
    })
    const content = completion.choices?.[0]?.message?.content || ''
    if (!content.trim()) throw new Error('Empty response from model')
    onChunk(content)
    return content
  } catch (fallbackErr) {
    throw new Error(friendlyError(fallbackErr))
  }
}

function buildMessagesWithinBudget(
  systemPrompt: string,
  history: AIHistoryMessage[] | undefined,
  query: string,
  contextLength: number
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const budget = normalizeContextLength(contextLength)
  // Reserve room for the model reply
  const replyReserve = Math.min(2048, Math.max(512, Math.floor(budget * 0.15)))
  let remaining = budget - replyReserve - estimateTokens(systemPrompt) - estimateTokens(query)

  const prior: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (history && history.length > 0 && remaining > 0) {
    // Prefer newest turns so the live question stays grounded
    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i]
      if (!turn?.content?.trim()) continue
      if (turn.role !== 'user' && turn.role !== 'assistant') continue
      const cost = estimateTokens(turn.content)
      if (cost > remaining) break
      prior.unshift({ role: turn.role, content: turn.content })
      remaining -= cost
    }
  }

  return [
    { role: 'system', content: systemPrompt },
    ...prior,
    { role: 'user', content: query },
  ]
}

/**
 * Ask with optional SSH command tools. When tools are enabled, uses a non-streaming
 * tool loop then streams (or emits) the final assistant text.
 */
export async function askAI(
  ai: AIConfig,
  query: string,
  context: AIAskContext | undefined,
  onChunk: (chunk: string) => void,
  hooks?: AIAskHooks,
  history?: AIHistoryMessage[]
): Promise<string> {
  if (ai.enabled === false) throw new Error('AI features are disabled in Settings')

  const client = createClient(ai)
  const model = ai.model.trim()
  const isLive = context?.connectionStatus === 'connected'
  const allowRunCommands =
    ai.allowRunCommands === true &&
    context?.server?.protocol === 'ssh' &&
    isLive &&
    typeof hooks?.runCommand === 'function'

  const systemPrompt = buildSystemPrompt(context, { allowRunCommands })
  const contextLength = normalizeContextLength(ai.contextLength)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = buildMessagesWithinBudget(
    systemPrompt,
    history,
    query,
    contextLength
  )

  if (!allowRunCommands) {
    return streamCompletion(client, model, messages, onChunk)
  }

  const tools = [RUN_SSH_COMMAND_TOOL]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let completion: OpenAI.Chat.ChatCompletion
    try {
      completion = await client.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: 'auto',
        stream: false,
      })
    } catch (err) {
      throw new Error(friendlyError(err))
    }

    const choice = completion.choices?.[0]?.message
    if (!choice) throw new Error('Empty response from model')

    const toolCalls = choice.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      const content = choice.content || ''
      if (!content.trim()) throw new Error('Empty response from model')
      onChunk(content)
      return content
    }

    messages.push({
      role: 'assistant',
      content: choice.content || null,
      tool_calls: toolCalls,
    })

    for (const call of toolCalls) {
      if (call.type !== 'function' || call.function.name !== 'run_ssh_command') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: `Unknown tool: ${(call as { function?: { name?: string } }).function?.name || 'unknown'}` }),
        })
        continue
      }

      const command = parseToolCommand(call.function.arguments)
      if (!command) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'Missing or invalid command argument' }),
        })
        continue
      }

      try {
        const result = await hooks!.runCommand!(command)
        if (result.error === 'denied') {
          hooks?.onCommandStatus?.({ command, phase: 'denied' })
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              error: 'User denied running this command',
              command,
            }),
          })
          continue
        }
        if (result.error) {
          hooks?.onCommandStatus?.({ command, phase: 'error', detail: result.error })
        } else {
          hooks?.onCommandStatus?.({ command, phase: 'done' })
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            command,
            exitCode: result.exitCode,
            output: truncateOutput(result.output || ''),
            ...(result.error ? { error: result.error } : {}),
          }),
        })
      } catch (execErr) {
        const message = execErr instanceof Error ? execErr.message : String(execErr)
        hooks?.onCommandStatus?.({ command, phase: 'error', detail: message })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: message, command }),
        })
      }
    }
  }

  // Final pass without tools so the model summarizes
  return streamCompletion(client, model, messages, onChunk)
}

export type { AppSettings }
