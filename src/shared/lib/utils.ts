import { clsx, type ClassValue } from 'clsx'

/** Слияние классов Tailwind. */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

let _n = 0
/** Детерминированно-уникальный id (без Math.random в hot-path рендера). */
export function uid(prefix = 'id') {
  _n += 1
  return `${prefix}_${Date.now().toString(36)}_${_n}`
}

/** Форматирование больших чисел: 35800 → "35.8K". */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Форматирование монет: 25.8 → "25.80". */
export function coins(n: number): string {
  return n.toFixed(2)
}

/** Пауза (для мок-задержек). */
export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** Секунды → "MM:SS". */
export function mmss(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Псевдослучайное, но детерминированное по seed — для стабильных мок-строк. */
export function seeded(seed: number) {
  let x = Math.sin(seed) * 10_000
  return x - Math.floor(x)
}

export function pick<T>(arr: T[], seed: number): T {
  return arr[Math.floor(seeded(seed) * arr.length) % arr.length]
}
