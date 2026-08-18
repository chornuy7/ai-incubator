import { useEffect, useState } from 'react'
import { Zap, Clock } from 'lucide-react'
import { fetchPricing, type Pricing } from '@/api/balanceApi'
import { cn, coins as fmtCoins } from '@/shared/lib/utils'

// Правка 14.08: кастомная тёмная плавающая подсказка (не нативный title) — как знаки «?».
function CostTip({ hint, className, children }: { hint: string; className: string; children: React.ReactNode }) {
  return (
    <span className={cn('group/lc relative inline-flex cursor-help', className)}>
      {children}
      <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-50 w-max max-w-[280px] -translate-x-1/2 whitespace-pre-line rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-[11px] font-medium leading-snug text-fg opacity-0 shadow-xl transition-opacity group-hover/lc:opacity-100">{hint}</span>
    </span>
  )
}

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
  // MR-149: показываем ЕДИНУЮ цену действия (база + текст по максимуму). Фолбэк на базу.
  const price = pricing?.actionsFull?.[moduleKey] ?? pricing?.actions?.[moduleKey] ?? 0
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

  // Округляем до ТЫСЯЧНЫХ — как сервер: до сотых прогноз расходился с фактом.
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  // MR-149 (созвон 12.08): оплата за отправку и за генерацию текста объединена в ОДНУ
  // фикс-цену за действие, посчитанную «как за максимум символов» (лимит Telegram 4096 /
  // 1024 с картинкой) и уже заложенную в action_price из админки. Отдельного расчёта
  // токенов на витрине больше нет — цена действия фиксированная и предсказуемая.
  const total = r3(price * n)
  const fmt = fmtCoins
  // Текст в цене есть только у ИИ-модулей — у просмотров/реакций/парсеров его нет (MR-149).
  const hasText = (pricing?.maxTextTokens?.[moduleKey] ?? 0) > 0

  // Компактный вид для нижней панели: цена и время — чипами, детали — в подсказке.
  if (compact) {
    const costHint = [
      `${n} ${plural(n, 'действие', 'действия', 'действий')} × ${price} ⚡ = ${fmt(total)} ⚡`,
      hasText
        ? 'Цена за действие фиксированная: текст оплачен по максимуму символов (4096 / 1024 с картинкой), сверх неё за токены не списывается.'
        : 'Цена за действие фиксированная.',
    ].join('\n')

    return (
      <>
        {hasCost && (
        <CostTip hint={costHint} className="h-10 items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 text-sm font-bold text-amber-300">
          <Zap size={16} fill="currentColor" />
          {fmt(total)}
        </CostTip>
        )}
        {timeAvg && (
          <CostTip hint={timeHint} className="h-10 items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 text-sm font-bold text-emerald-300">
            <Clock size={16} /> ≈ {timeAvg}
          </CostTip>
        )}
      </>
    )
  }

  // Полный вид — это карточка ПРО ЦЕНУ: без прайса показывать нечего.
  if (!hasCost) return null

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-amber-500/25 bg-amber-500/8 px-4 py-2.5 text-sm">
      <Zap size={15} className="text-amber-400" fill="currentColor" />
      <span className="font-semibold text-fg">Спишется {fmt(total)} ⚡</span>
      <span className="text-muted">
        — {n} {plural(n, 'действие', 'действия', 'действий')} × {price} ⚡{hasText ? ' (текст по максимуму символов уже в цене)' : ''}
      </span>
      {timeAvg && (
        <CostTip hint={timeHint} className="ml-auto items-center gap-1 text-sm font-semibold text-emerald-300">
          <Clock size={14} /> ≈ {timeAvg}
        </CostTip>
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
  // MR-149: показываем ЕДИНУЮ цену действия (база + текст по максимуму). Фолбэк на базу.
  const price = pricing?.actionsFull?.[moduleKey] ?? pricing?.actions?.[moduleKey] ?? 0
  if (!pricing || !price) return null
  // «Действие = до N символов» имеет смысл только там, где действие ГЕНЕРИТ ИИ-текст
  // (комментинг/чаттинг/диалоги/мейлинг). У просмотров/реакций/парсеров текста нет —
  // строку про символы там не показываем (MR-149).
  const hasText = (pricing?.maxTextTokens?.[moduleKey] ?? 0) > 0
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-amber-500/20 bg-amber-500/[.05] px-4 py-2.5 text-sm">
      <span className="flex items-center gap-1.5 font-bold text-amber-300">
        <Zap size={15} fill="currentColor" /> {fmtCoins(price)} ⚡
        <span className="font-normal text-white/60">за действие</span>
      </span>
      {hasText && <span className="text-white/50">1 действие = до 4096 символов (1024 с картинкой)</span>}
    </div>
  )
}
