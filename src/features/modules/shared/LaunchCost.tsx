import { useEffect, useState } from 'react'
import { Zap } from 'lucide-react'
import { fetchPricing, type Pricing } from '@/api/balanceApi'
import { coins as fmtCoins } from '@/shared/lib/utils'

/**
 * §5.1: во сколько обойдётся запуск — ДО нажатия «Начать».
 *
 * Раньше цену узнавали по факту: человек запускал и смотрел, как убывает баланс.
 * Считаем две части отдельно, потому что они принципиально разные:
 *  - действия — фикс по прайсу, сумма точная;
 *  - токены ИИ — оценка по СВОЕЙ истории (средний расход на действие в этом модуле),
 *    потому что длина промпта и ответа заранее неизвестна.
 * Если истории ещё нет — честно говорим, что считать не на чем, вместо выдуманного числа.
 */
export function LaunchCost({ moduleKey, actions }: { moduleKey: string; actions: number }) {
  const [pricing, setPricing] = useState<Pricing | null>(null)
  useEffect(() => { void fetchPricing().then(setPricing).catch(() => {}) }, [])

  const n = Math.max(0, Math.round(actions) || 0)
  const price = pricing?.actions?.[moduleKey] ?? 0
  if (!pricing || !price || !n) return null

  // Округляем до ТЫСЯЧНЫХ — как сервер: до сотых прогноз расходился с фактом
  // (3 строки парсера: обещали 0.02, списывается 0.015).
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  const actionsCost = r3(price * n)
  const avgTokens = pricing.avgTokens?.[moduleKey] ?? 0
  const tokens = avgTokens * n
  const tokensCost = r3((tokens / 1000) * pricing.coinsPer1kTokens)
  const total = r3(actionsCost + tokensCost)
  const fmt = fmtCoins

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-amber-500/25 bg-amber-500/8 px-4 py-2.5 text-sm">
      <Zap size={15} className="text-amber-400" fill="currentColor" />
      <span className="font-semibold text-fg">
        Спишется {avgTokens ? '≈ ' : ''}{fmt(total)} ⚡
      </span>
      <span className="text-muted">
        — {n} {plural(n, 'действие', 'действия', 'действий')} × {price} ⚡ = {fmt(actionsCost)} ⚡
        {avgTokens > 0 && <> · ИИ ≈ {Math.round(tokens).toLocaleString('ru-RU')} токенов ({fmt(tokensCost)} ⚡)</>}
      </span>
      {avgTokens === 0 && (
        <span className="text-xs text-muted">
          Расход ИИ добавится по факту — пока нет истории этого модуля, чтобы оценить.
        </span>
      )}
    </div>
  )
}

/** Русские окончания: «1 действие», «2 действия», «5 действий». */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
