import { useEffect, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'

type Role = 'owner' | 'group' | 'other'
type Flag = 'r' | 'w' | 'x'

const ROLES: { key: Role; label: string }[] = [
  { key: 'owner', label: 'Owner' },
  { key: 'group', label: 'Group' },
  { key: 'other', label: 'Other' },
]

const FLAGS: { key: Flag; label: string; bit: number }[] = [
  { key: 'r', label: 'Read', bit: 4 },
  { key: 'w', label: 'Write', bit: 2 },
  { key: 'x', label: 'Execute', bit: 1 },
]

const ROLE_SHIFT: Record<Role, number> = { owner: 6, group: 3, other: 0 }

/** Parse symbolic (rwxr-xr-x), typed (-rwxr-xr-x), or octal (755 / 0755) into 0–0o777. */
export function parsePermissions(value?: string): number {
  if (!value) return 0
  const raw = value.trim()
  if (/^[0-7]{3,4}$/.test(raw)) return parseInt(raw.slice(-3), 8) & 0o777
  const sym = raw.replace(/^[\-dlbcps]/, '')
  if (!/^[rwx\-]{9}$/i.test(sym)) return 0
  let n = 0
  for (let i = 0; i < 9; i++) {
    const c = sym[i].toLowerCase()
    const shift = 6 - Math.floor(i / 3) * 3
    if (c === 'r') n |= 4 << shift
    else if (c === 'w') n |= 2 << shift
    else if (c === 'x') n |= 1 << shift
  }
  return n & 0o777
}

export function modeToOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

function hasFlag(mode: number, role: Role, flag: Flag): boolean {
  const bit = FLAGS.find(f => f.key === flag)!.bit
  return ((mode >> ROLE_SHIFT[role]) & bit) !== 0
}

function toggleFlag(mode: number, role: Role, flag: Flag): number {
  const bit = FLAGS.find(f => f.key === flag)!.bit << ROLE_SHIFT[role]
  return (mode ^ bit) & 0o777
}

interface PermissionsDialogProps {
  entry: FileEntry
  onClose: () => void
  onSave: (modeOctal: string) => Promise<boolean>
}

export default function PermissionsDialog({ entry, onClose, onSave }: PermissionsDialogProps) {
  const [mode, setMode] = useState(() => parsePermissions(entry.permissions))
  const [octal, setOctal] = useState(() => modeToOctal(parsePermissions(entry.permissions)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const backdropMouseDownRef = useRef(false)

  useEffect(() => {
    const next = parsePermissions(entry.permissions)
    setMode(next)
    setOctal(modeToOctal(next))
    setError(null)
  }, [entry])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving])

  const syncFromMode = (next: number) => {
    setMode(next)
    setOctal(modeToOctal(next))
    setError(null)
  }

  const onOctalChange = (value: string) => {
    const cleaned = value.replace(/[^0-7]/g, '').slice(0, 4)
    setOctal(cleaned)
    setError(null)
    if (/^[0-7]{3,4}$/.test(cleaned)) {
      setMode(parseInt(cleaned.slice(-3), 8) & 0o777)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const normalized = /^[0-7]{3,4}$/.test(octal) ? modeToOctal(parseInt(octal.slice(-3), 8)) : modeToOctal(mode)
    setSaving(true)
    setError(null)
    try {
      const ok = await onSave(normalized)
      if (!ok) {
        setError('Failed to change permissions. The server may not support chmod.')
        return
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[70]"
      onMouseDown={e => {
        backdropMouseDownRef.current = e.target === e.currentTarget
      }}
      onClick={e => {
        if (e.target === e.currentTarget && backdropMouseDownRef.current && !saving) onClose()
      }}
    >
      <div
        className="bg-card border border-border rounded-lg w-full max-w-sm p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-semibold mb-1">Permissions</h3>
        <p className="text-xs text-muted-foreground mb-4 font-mono truncate" title={entry.path}>
          {entry.name}{entry.type === 'dir' ? '/' : ''}
        </p>

        <form onSubmit={e => void submit(e)} className="space-y-4">
          <div className="grid grid-cols-[4.5rem_1fr_1fr_1fr] gap-y-2 gap-x-2 text-sm items-center">
            <div />
            {FLAGS.map(f => (
              <div key={f.key} className="text-center text-xs text-muted-foreground">
                {f.label}
              </div>
            ))}
            {ROLES.map(role => (
              <div key={role.key} className="contents">
                <div className="text-xs text-muted-foreground">{role.label}</div>
                {FLAGS.map(f => (
                  <label key={f.key} className="flex justify-center">
                    <input
                      type="checkbox"
                      className="rounded border-border"
                      checked={hasFlag(mode, role.key, f.key)}
                      onChange={() => syncFromMode(toggleFlag(mode, role.key, f.key))}
                      disabled={saving}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Numeric value</label>
            <input
              className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm font-mono"
              value={octal}
              onChange={e => onOctalChange(e.target.value)}
              inputMode="numeric"
              maxLength={4}
              disabled={saving}
              autoFocus
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex-1 py-2 rounded border border-border disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !/^[0-7]{3,4}$/.test(octal)}
              className="flex-1 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'OK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
