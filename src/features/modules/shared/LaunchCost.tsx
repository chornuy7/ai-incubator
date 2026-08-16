import { useEffect, useState } from 'react'
import { Zap, Clock } from 'lucide-react'
import { fetchPricing, type Pricing } from '@/api/balanceApi'
import { coins as fmtCoins } from '@/shared/lib/utils'

/**
 * Прайс один на всё приложение и меняется редко — держим его в модульном кэше.
 *
 * Раньше КАЖДОЕ открытие модуля заново дёргало `/api/pricing`, и до ответа плашки не
 * рисовались вовсе: «появляется долго, аж раздражает» (13.08). Теперь первый запрос
 * один на сессию, а все последующие открытия берут готовое значение синхронно.
 * `inflight` нужен, чтобы два модуля, смонтированные разом, не слали два запроса.
 */
let pricingCache: Pricing | null = null
let inflight: Promise<Pricing> | null = null

function usePricing(): Pricing | null {
  const [pricing, setPricing] = useState<Pricing | null>(pricingCache)
  useEffect(() => {
    if (pricingCache) return // уже знаем — рисуем сразу, без сети
    let alive = true
    inflight = inflight || fetchPricing()
    void inflight
      .then((p) => { pricingCache = p; if (alive) setPricing(p) })
      .catch(() => { inflight = null }) // дать шанс повторить на следующем открытии
    return () => { alive = false }
  }, [])
  return pricing
}

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
  const pricing = usePricing()

  const n = Math.max(0, Math.round(actions) || 0)
  const price = pricing?.actions?.[moduleKey] ?? 0
  // Время НЕ зависит от прайса — оно считается из действий, аккаунтов и задержек. Раньше
  // общий ранний выход прятал и его тоже, пока не ответит `/api/pricing`.
  const hasCost = !!pricing && !!price && !!n
  if (!n) return null

  // §10.1: оценка времени. Действия делятся между аккаунтами и идут последовательно
  // на каждом с задержкой — «100 аккаунтов × 10 c → 6–8 часов». min–max от разброса
  // задержки. Без аккаунтов/задержки время не показываем, а не выдумываем.
  const acc = Math.max(1, Math.round(accounts || 0))
  // Аккаунты ещё не выбраны — считаем время как для ОДНОГО (худший случай: всё делает
  // один профиль). Раньше время в этом случае просто не показывалось, и после того как
  // из панели убрали чип «≈ ВРЕМЯ», его не стало видно вовсе (замечание 13.08).
  const perAcc = Math.ceil(n / acc)
  // ОДНО число вместо «5 мин–20 мин» (правка 13.08): диапазон читался как «программа
  // сама не знает». Берём среднюю задержку — это и есть ожидаемое время; разброс и вся
  // арифметика уходят в подсказку при наведении.
  const avgDelay = delaySec ? (delaySec[0] + delaySec[1]) / 2 : 0
  const timeAvg = perAcc && avgDelay ? fmtDur(perAcc * avgDelay) : null
  const timeHint = timeAvg
    ? [
      `${n} ${plural(n, 'действие', 'действия', 'действий')} ÷ ${acc} ${plural(acc, 'аккаунт', 'аккаунта', 'аккаунтов')} = ${perAcc} на каждый`,
      `${perAcc} × ~${Math.round(avgDelay)} с между действиями ≈ ${timeAvg}`,
      delaySec ? `разброс задержки ${delaySec[0]}–${delaySec[1]} с: от ${fmtDur(perAcc * delaySec[0])} до ${fmtDur(perAcc * delaySec[1])}` : '',
      accounts ? '' : 'аккаунты не выбраны — считаем как для одного',
    ].filter(Boolean).join('\n')
    : ''

  // Округляем до ТЫСЯЧНЫХ — как сервер: до сотых прогноз расходился с фактом
  // (3 строки парсера: обещали 0.02, списывается 0.015).
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  const actionsCost = r3(price * n)
  const avgTokens = pricing?.avgTokens?.[moduleKey] ?? 0
  const tokens = avgTokens * n
  const tokensCost = r3((tokens / 1000) * (pricing?.coinsPer1kTokens ?? 0))
  const total = r3(actionsCost + tokensCost)
  const fmt = fmtCoins

  // Компактный вид для нижней панели: цена и время — чипами, детали — в подсказке.
  if (compact) {
    // В панели запуска — только ИТОГ и время, крупными плашками под стать кнопкам справа.
    // Разбивку «= действия + ИИ» и попап с математикой убрали (правка заказчика 13.08):
    // оператору перед запуском нужны две цифры — сколько спишется и сколько ждать, а
    // из чего складывается цена (и что часть уходит на ИИ) — не его забота.
    // Расчёт списания — тоже в подсказку: на плашке одна цифра, при наведении видно,
    // из чего она сложилась. Про ИИ отдельной строкой не пишем — только общий итог.
    const costHint = [
      `${n} ${plural(n, 'действие', 'действия', 'действий')} × ${price} ⚡ = ${fmt(actionsCost)} ⚡`,
      avgTokens > 0 ? `+ текст ≈ ${fmt(tokensCost)} ⚡ (спишется по факту)` : '',
      `итого ${avgTokens ? '≈ ' : ''}${fmt(total)} ⚡`,
    ].filter(Boolean).join('\n')

    return (
      <>
        {/* Цена ждёт прайс, время — нет: показываем каждую плашку, как только она готова. */}
        {hasCost && (
        <span
          className="inline-flex h-10 cursor-help items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 text-sm font-bold text-amber-300"
          title={costHint}
        >
          {/* Иконка уже есть — символ ⚡ в тексте давал две молнии подряд. */}
          <Zap size={16} fill="currentColor" />
          {avgTokens ? '≈' : ''}{fmt(total)}
        </span>
        )}
        {timeAvg && (
          <span
            className="inline-flex h-10 cursor-help items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 text-sm font-bold text-emerald-300"
            title={timeHint}
          >
            <Clock size={16} /> ≈ {timeAvg}
          </span>
        )}
      </>
    )
  }

  // Полный вид — это карточка ПРО ЦЕНУ: без прайса показывать нечего.
  if (!hasCost) return null

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-amber-500/25 bg-amber-500/8 px-4 py-2.5 text-sm">
      <Zap size={15} className="text-amber-400" fill="currentColor" />
      <span className="font-semibold text-fg">
        Спишется {avgTokens ? '≈ ' : ''}{fmt(total)} ⚡
      </span>
      <span className="text-muted">
        — {n} {plural(n, 'действие', 'действия', 'действий')} × {price} ⚡ = {fmt(actionsCost)} ⚡
        {avgTokens > 0 && <> · текст ИИ ≈ {Math.round(tokens).toLocaleString('ru-RU')} ток. ÷ 1000 × {pricing?.coinsPer1kTokens ?? 0} ⚡ = {fmt(tokensCost)} ⚡</>}
      </span>
      {timeAvg && (
        <span className="ml-auto inline-flex cursor-help items-center gap-1 text-sm font-semibold text-emerald-300" title={timeHint}>
          <Clock size={14} /> ≈ {timeAvg}
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
 * MR-149 → MR-163: мини-калькулятор в шапке модуля (перед «Выбором аккаунтов»).
 *
 * Показывает ЦЕНУ ЗА ОДНО ДЕЙСТВИЕ ровно такой, как она задана в админ-панели. Раньше
 * сюда подмешивалась средняя себестоимость текста, и на витрине вместо «0.05» появлялось
 * «0.0715» — заказчик 14.08: «значение должно быть такое же, как написано в админке…
 * чистое значение». Полная стоимость задачи считается внизу, в панели запуска, и
 * дублировать её сверху нельзя.
 *
 * Если действия у модуля бесплатны (нет цены) — блок не показываем.
 */
export function ActionPriceCalc({ moduleKey }: { moduleKey: string }) {
  // Тот же кэш прайса, что и у LaunchCost: два компонента на одной странице больше не
  // шлют два запроса, а при повторном открытии модуля цена рисуется сразу.
  const pricing = usePricing()
  const price = pricing?.actions?.[moduleKey] ?? 0
  if (!pricing || !price) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-amber-500/20 bg-amber-500/[.05] px-4 py-2.5 text-sm">
      <span className="flex items-center gap-1.5 font-bold text-amber-300">
        <Zap size={15} fill="currentColor" /> {fmtCoins(price)} ⚡
        <span className="font-normal text-white/60">за действие</span>
      </span>
      <span className="text-white/50">1 действие = до 5000 символов (1024 с картинкой)</span>
    </div>
  )
}
