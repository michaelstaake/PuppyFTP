import type { AIChatMessage } from '@shared/types'

/** Rough token estimate (~4 chars/token) — matches main-process budgeting. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: AIChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    if (!m.content) continue
    total += estimateTokens(m.content)
  }
  // Small overhead for roles / formatting
  total += messages.length * 4
  return total
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`
  }
  return String(n)
}
