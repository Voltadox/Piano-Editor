/** Small settings kept between sessions. Storage can be unavailable; callers always get a usable value. */
const PREFIX = 'keyfall.'

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    const v = JSON.parse(raw) as T
    // merge objects so settings added in later versions get their defaults
    return fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? { ...fallback, ...v } : v
  } catch {
    return fallback
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // storage unavailable; the setting just won't persist
  }
}
