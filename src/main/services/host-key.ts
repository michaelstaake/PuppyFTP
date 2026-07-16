import { createHash } from 'crypto'
import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'

/** OpenSSH-style key fingerprint: base64 of the SHA-256 hash of the raw host key blob. */
export function fingerprintSha256(hostKey: Buffer): string {
  return createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')
}

export type HostKeyDecision = 'accept' | 'reject'

function buildDialogOptions(
  serverName: string,
  host: string,
  storedFingerprint: string | undefined,
  fingerprint: string
): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: ['Accept new key', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'SSH host key changed',
    message: `The host key for "${serverName}" (${host}) has changed.`,
    detail:
      `Previously trusted fingerprint:\n${storedFingerprint ?? '(unknown)'}\n\n` +
      `New fingerprint:\n${fingerprint}\n\n` +
      'This can happen after a legitimate server rebuild, but it can also indicate a ' +
      'man-in-the-middle attack. Only accept if you are certain this change is expected.',
  }
}

/**
 * Builds an ssh2 `hostVerifier` implementing trust-on-first-use (TOFU) host key checking.
 *
 * ssh2 calls this with the raw host key Buffer and a `verify(ok: boolean)` callback. If the
 * function returns a boolean synchronously (not `undefined`), ssh2 uses that value and never
 * calls `verify` itself. We use that for the "no dialog needed" fast paths, and use the async
 * callback path (or a blocking fallback) only when we need to prompt the user.
 */
export function createHostKeyVerifier(opts: {
  serverName: string
  host: string
  storedFingerprint?: string
  onAccept: (fingerprint: string) => void
  getParentWindow?: () => BrowserWindow | null
}): (key: Buffer, callback?: (ok: boolean) => void) => boolean | void {
  return (key: Buffer, callback?: (ok: boolean) => void): boolean | void => {
    const fingerprint = fingerprintSha256(key)

    // First connection to this host — trust it and persist the fingerprint.
    if (!opts.storedFingerprint) {
      opts.onAccept(fingerprint)
      if (callback) {
        callback(true)
        return undefined
      }
      return true
    }

    // Unchanged — accept without prompting.
    if (fingerprint === opts.storedFingerprint) {
      if (callback) {
        callback(true)
        return undefined
      }
      return true
    }

    // Changed — warn the user before trusting the new key.
    const dialogOptions = buildDialogOptions(opts.serverName, opts.host, opts.storedFingerprint, fingerprint)
    const parent = opts.getParentWindow?.() ?? undefined

    if (callback) {
      const showAsync = parent
        ? dialog.showMessageBox(parent, dialogOptions)
        : dialog.showMessageBox(dialogOptions)
      showAsync
        .then(result => {
          const accepted = result.response === 0
          if (accepted) opts.onAccept(fingerprint)
          callback(accepted)
        })
        .catch(() => callback(false))
      return undefined
    }

    // No callback provided (sync hostVerifier form) — block for the decision.
    const result = parent
      ? dialog.showMessageBoxSync(parent, dialogOptions)
      : dialog.showMessageBoxSync(dialogOptions)
    const accepted = result === 0
    if (accepted) opts.onAccept(fingerprint)
    return accepted
  }
}
