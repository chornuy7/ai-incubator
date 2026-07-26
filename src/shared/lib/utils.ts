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

/**
 * Форматирование монет: 25.8 → "25.80", 0.005 → "0.005".
 *
 * Сервер считает ТЫСЯЧНЫМИ (строка парсера стоит 0.005), поэтому жёсткий toFixed(2)
 * врал: расход 0.045 показывался как «0.05», а 0.004 — как «0.00», то есть «ничего
 * не потратил». Два знака оставляем как обычный вид, третий показываем только когда
 * он есть и значим.
 */
export function coins(n: number): string {
  const v = Number(n) || 0
  const milli = Math.round(v * 1000)
  // Смотрим ИМЕННО третий знак, а не `Number.isInteger(x * 100)`: 0.07 * 100 в
  // плавающей точке даёт 7.000000000000001, и 0.07 печаталось как «0.070».
  return milli % 10 === 0 ? (milli / 1000).toFixed(2) : (milli / 1000).toFixed(3)
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
