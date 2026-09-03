import type { ReactNode } from 'react'
import { Card } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'

/**
 * Общие хелперы и мелкие компоненты админ-панели — вынесены из AdminStatsPage, чтобы
 * тот не был god-file и вкладки могли переиспользовать форматтеры из одного места.
 */

export const fmt = (n: number) => new Intl.NumberFormat('ru-RU').format(Math.round(n))
export const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('ru-RU')

/** Санитайзер цены: только цифры и одна точка, значение капим (иначе поле принимало
 *  «221231…» и цифры не влезали). Разрешаем незавершённый ввод «12.» / «12.0». */
export const cleanPrice = (v: string, max: number): string => {
  let s = v.replace(/[^\d.]/g, '')
  const i = s.indexOf('.')
  if (i !== -1) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '') // только одна точка
  s = s.replace(/^0+(?=\d)/, '') // «020» → «20» (но «0.5» и «0» сохраняем) — без ложного «изменено»
  const n = Number(s)
  return Number.isFinite(n) && n > max ? String(max) : s
}

/** §10.1: цена токена мизерная (2.6e-7) — показываем обычным десятичным, без 'e-7'. */
export const fmtUsd = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  // до 12 знаков, срезаем хвостовые нули: 0.0000002625, а не 2.625e-7 и не …000
  return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
}

/** §10.4: «≈ $X» — $-эквивалент монет по курсу. null, если показывать нечего (одно правило на все места). */
export const usdEq = (coins?: number | null, rate?: number): string | null =>
  coins && rate ? `≈ $${(coins * rate).toFixed(2)}` : null

/** Плитка-метрика: подпись, крупное число, необязательный подтекст и тон значения. */
export function MetricTile({ label, value, sub, tone }: { label: ReactNode; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn('font-display text-2xl font-bold', tone || 'text-fg')}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </Card>
  )
}
