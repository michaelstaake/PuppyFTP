import type { ResolvedTheme, ThemePreference } from '@shared/types'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  if (isThemePreference(value)) return value
  return 'system'
}

export async function resolveTheme(preference: ThemePreference): Promise<ResolvedTheme> {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'

  if (window.electronAPI?.getSystemTheme) {
    return window.electronAPI.getSystemTheme()
  }

  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  return 'dark'
}

export function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.classList.toggle('light', resolved === 'light')
  root.style.colorScheme = resolved
  void window.electronAPI?.setThemeChrome?.(resolved)
}
