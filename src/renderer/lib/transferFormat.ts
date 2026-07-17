/** Human-readable byte size (e.g. 1.2 MB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const digits = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[i]}`
}

/** System tray hover text: transfer summary, or app name + version when idle. */
export function formatTrayToolTip(
  activeCount: number,
  remainingBytes: number,
  version: string
): string {
  if (activeCount <= 0) return `PuppyFTP ${version}`
  return `${activeCount} Files Transferring\n${formatBytes(remainingBytes)} Remaining`
}

/** Human-readable transfer speed. */
export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—'
  return `${formatBytes(bps)}/s`
}

export function fileNameFromPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || filePath
}
