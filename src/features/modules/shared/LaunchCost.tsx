import { useEffect, useState } from 'react'
import { Zap, Clock, Info } from 'lucide-react'
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
export function LaunchCost({ moduleKey, actions, accounts, delaySec, compact }: {
  moduleKey: string
  actions: number
  /** Сколько аккаунтов делят работу — для оценки времени (§10.1). */
  accounts?: number
  /** Диапазон задержки между действиями, секунды [min, max] — для времени. */
  delaySec?: [number, number]
  /**
   * Компактно — строкой-чипом для нижней панели запуска: там место дорогое, а
   * подробности (сколько действий × цена, сколько токенов) уезжают в подсказку.
   */
  compact?: boolean
}) {
  const [pricing, setPricing] = useState<Pricing | null>(null)
  useEffect(() => { void fetchPricing().then(setPricing).catch(() => {}) }, [])

  const n = Math.max(0, Math.round(actions) || 0)
  const price = pricing?.actions?.[moduleKey] ?? 0
  if (!pricing || !price || !n) return null

  // §10.1: оценка времени. Действия делятся между аккаунтами и идут последовательно
  // на каждом с задержкой — «100 аккаунтов × 10 c → 6–8 часов». min–max от разброса
  // задержки. Без аккаунтов/задержки время не показываем, а не выдумываем.
  const acc = Math.max(1, Math.round(accounts || 0))
  // Аккаунты ещё не выбраны — считаем время как для ОДНОГО (худший случай: всё делает
  // один профиль). Раньше время в этом случае просто не показывалось, и после того как
  // из панели убрали чип «≈ ВРЕМЯ», его не стало видно вовсе (замечание 13.08).
  const perAcc = Math.ceil(n / acc)
  const timeMin = perAcc && delaySec ? fmtDur(perAcc * delaySec[0]) : null
  const timeMax = perAcc && delaySec ? fmtDur(perAcc * delaySec[1]) : null

  // Округляем до ТЫСЯЧНЫХ — как сервер: до сотых прогноз расходился с фактом
  // (3 строки парсера: обещали 0.02, списывается 0.015).
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  const actionsCost = r3(price * n)
  const avgTokens = pricing.avgTokens?.[moduleKey] ?? 0
  const tokens = avgTokens * n
  const tokensCost = r3((tokens / 1000) * pricing.coinsPer1kTokens)
  const total = r3(actionsCost + tokensCost)
  const fmt = fmtCoins

  // Компактный вид для нижней панели: цена и время — чипами, детали — в подсказке.
  if (compact) {
    // В панели запуска — только ИТОГ и время, крупными плашками под стать кнопкам справа.
    // Разбивку «= действия + ИИ» и попап с математикой убрали (правка заказчика 13.08):
    // оператору перед запуском нужны две цифры — сколько спишется и сколько ждать, а
    // из чего складывается цена (и что часть уходит на ИИ) — не его забота.
    return (
      <>
        <span
          className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 text-sm font-bold text-amber-300"
          title="Спишется с баланса за этот запуск"
        >
          {/* Иконка уже есть — символ ⚡ в тексте давал две молнии подряд. */}
          <Zap size={16} fill="currentColor" />
          {avgTokens ? '≈' : ''}{fmt(total)}
        </span>
        {timeMin && (
          <span
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 text-sm font-bold text-emerald-300"
            title="Ориентировочное время прогона"
          >
            <Clock size={16} /> {timeMin === timeMax ? timeMin : `${timeMin}–${timeMax}`}
          </span>
        )}
      </>
    )
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-amber-500/25 bg-amber-500/8 px-4 py-2.5 text-sm">
      <Zap size={15} className="text-amber-400" fill="currentColor" />
      <span className="font-semibold text-fg">
        Спишется {avgTokens ? '≈ ' : ''}{fmt(total)} ⚡
      </span>
      <span className="text-muted">
        — {n} {plural(n, 'действие', 'действия', 'действий')} × {price} ⚡ = {fmt(actionsCost)} ⚡
        {avgTokens > 0 && <> · текст ИИ ≈ {Math.round(tokens).toLocaleString('ru-RU')} ток. ÷ 1000 × {pricing.coinsPer1kTokens} ⚡ = {fmt(tokensCost)} ⚡</>}
      </span>
      {timeMin && (
        <span className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-emerald-300">
          <Clock size={14} /> {timeMin === timeMax ? timeMin : `${timeMin}–${timeMax}`}
        </span>
      )}
      {avgTokens === 0 && (
        <span className="w-full text-xs text-muted">
          Расход ИИ добавится по факту — пока нет истории этого модуля, чтобы оценить.
        </span>
      )}
    </div>
  )
}

/** Секунды → человекочитаемо: «45 с», «12 мин», «6 ч 20 мин». */
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} с`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} ч ${rm} мин` : `${h} ч`
}

/** Русские окончания: «1 действие», «2 действия», «5 действий». */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/**
 * MR-149: мини-калькулятор в шапке модуля (перед «Выбором аккаунтов»). Показывает
 * ЕДИНУЮ цену за действие — отправка + генерация текста ИИ объединены в одну сумму —
 * и сколько символов покрывает одно действие (лимит Telegram ~5000 / 1024 с картинкой).
 * Себестоимость текста берём как среднюю по истории модуля (как в LaunchCost).
 * Если действия у модуля бесплатны (нет цены) — не показываем.
 */
export function ActionPriceCalc({ moduleKey }: { moduleKey: string }) {
  const [pricing, setPricing] = useState<Pricing | null>(null)
  useEffect(() => { void fetchPricing().then(setPricing).catch(() => {}) }, [])
  const price = pricing?.actions?.[moduleKey] ?? 0
  if (!pricing || !price) return null
  const avgTokens = pricing.avgTokens?.[moduleKey] ?? 0
  const tokenCost = avgTokens ? (avgTokens / 1000) * pricing.coinsPer1kTokens : 0
  // Единая цена за действие = действие + текст (по максимуму символов чарджим одинаково).
  const perAction = Math.round((price + tokenCost) * 1000) / 1000
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-amber-500/20 bg-amber-500/[.05] px-4 py-2.5 text-sm">
      <span className="flex items-center gap-1.5 font-bold text-amber-300">
        <Zap size={15} fill="currentColor" /> {fmtCoins(perAction)} ⚡
        <span className="font-normal text-white/60">за действие</span>
      </span>
      <span className="text-white/50">1 действие = до 5000 символов (1024 с картинкой)</span>
      {avgTokens > 0 && <span className="flex items-center gap-1 text-xs text-white/35"><Info size={12} /> цена включает генерацию текста ИИ</span>}
    </div>
  )
}
