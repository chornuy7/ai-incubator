import { useEffect, useRef, useState } from 'react'
import { PRESET_MUL, useGlobalPace, taskSeconds, joinSeconds, perAccountShare } from '@/shared/lib/pace'
import { Timer, Bolt, Settings2, Shield, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { ToggleGroup } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { SectionCard, NumberField, MinMaxField, DelayFields, SingleDelayField } from './index'
import { InfoTip } from './ProtectionBlock'

export interface DelaysShape {
  comment: [number, number]
  action: [number, number]
  join: [number, number]
  floodWait: number
  floodQuarantine: number
}

interface MinMaxCtl { min: number; max: number; onMin: (n: number) => void; onMax: (n: number) => void }

export interface TimingSectionProps {
  /**
   * Рисовать БЕЗ своей карточки — блок встраивается в «Защиту» (правка 19.08).
   * Защита и тайминги — одно решение: уровень защиты умножает задержки, а FloodWait
   * ведёт в карантин. Держать их в двух карточках значило заставлять человека
   * настраивать одно и то же в двух местах.
   */
  bare?: boolean
  /**
   * Что рисуем. Лимиты («Режим работы», «сколько сделает 1 аккаунт», «мин. слов»)
   * относятся к ОБЪЁМУ задачи и живут в «Параметрах и лимитах»; задержки — к темпу и
   * живут в «Защите и таймингах». До 19.08 обе половины стояли в одной карточке.
   */
  part?: 'all' | 'limits' | 'delays'
  /** Ряд пресетов рисует родитель (общий с защитой) — здесь его прятать. */
  hidePresets?: boolean
  /** Готовый множитель задержек. Передан — используем его вместо PRESET_MUL. */
  mulOverride?: number
  /** Переключатель режима работы (например ['По количеству','По времени']). */
  workModeOptions?: string[]
  workMode?: number
  onWorkMode?: (n: number) => void
  workModeLabel?: string

  /** Длительность в минутах (для режима «по времени» или показывать всегда). */
  durationMinutes?: number
  onDuration?: (n: number) => void
  showDurationAlways?: boolean
  durationPeriodHint?: string

  /** Общий лимит действий (min/max). */
  totalLabel?: string
  total?: MinMaxCtl | null
  /** Если задан — «Всего» не редактируется, а считается авто = на-аккаунт × число аккаунтов (§3.5). */
  computedTotal?: { value: number; accounts: number } | null
  /** Лимит на аккаунт (min/max). */
  perAccount?: MinMaxCtl | null
  /** Мин. слов в посте. */
  minWords?: { value: number; onChange: (n: number) => void } | null

  /** Задержки. */
  delays: DelaysShape
  onDelays: (updater: (d: DelaysShape) => DelaysShape) => void
  showComment?: boolean
  showAction?: boolean
  showJoin?: boolean
  /** Сколько целей выбрано — вступление в каждую занимает время (§ задержка вступления). */
  targetsCount?: number
  labels?: { comment?: string; action?: string; join?: string }

  delayPresets?: string[]
  delayPreset?: number
  onDelayPreset?: (n: number) => void
}

// §3.2 (MR-103): пресет темпа выбирается карточками — единый визуальный язык с «Защитой»
// (Консервативный/Сбалансированный/Агрессивный). Описания по индексу: 0 — минимальные
// задержки (быстрее), 1 — рекомендуемо, 2 — максимальные задержки (безопаснее).
// Множители темпа живут в shared/lib/pace.ts — там же, откуда их берёт ETA в дашборде,
// и там же они сверяются с сервером (server/__tests__/paceContract.test.js). Реэкспорт —
// чтобы модули, считающие «полное время», брали ту же шкалу.
export { PRESET_MUL } from '@/shared/lib/pace'

const PRESET_META = [
  {
    desc: 'Выше скорость, выше риск', icon: Bolt,
    tooltip: 'Паузы ~×0.6 (чаще), длительность ~×0.75 (короче). Быстрее — но выше шанс FloodWait, карантина и ограничений. Для прогретых, «расходных» аккаунтов. Лимит действий берётся базовый (меняется только в Custom).',
  },
  {
    desc: 'Рекомендуется', icon: Settings2,
    tooltip: 'Базовые задержки (×1) и длительность. Оптимальный баланс скорости и безопасности, для повседневной работы.',
  },
  {
    desc: 'Макс. задержки, безопаснее', icon: Shield,
    tooltip: 'Паузы ~×1.8 (реже), длительность ~×1.5 (дольше). Медленнее — минимум FloodWait и риска бана. Для новых и дорогих аккаунтов. Лимит действий берётся базовый (меняется только в Custom).',
  },
]

/**
 * (3) Единая секция «Тайминги и задержки»: сверху — пресет темпа карточками (как «Защита»),
 * а точная настройка (режим работы, лимиты, задержки) спрятана под «Расширенные настройки»,
 * чтобы по умолчанию хватало одного выбора Мин/Рекомендуемые/Макс. Все числовые поля
 * поддерживают ручной ввод (NumberField/Stepper).
 */
export function TimingSection(props: TimingSectionProps) {
  const {
    bare, part = 'all', hidePresets, mulOverride,
    workModeOptions, workMode = 0, onWorkMode, workModeLabel = 'Режим работы',
    durationMinutes = 60, onDuration, showDurationAlways, durationPeriodHint,
    totalLabel = 'Действия', total, computedTotal, perAccount, minWords,
    delays, onDelays, showComment, showAction = true, showJoin = true, targetsCount, labels = {},
    delayPresets, delayPreset = 1, onDelayPreset,
  } = props

  const hasPresets = !!(delayPresets && onDelayPreset)
  // Нет пресета темпа — раскрываем детали сразу (иначе всё окажется спрятано ни за чем).
  const [advanced, setAdvanced] = useState(!hasPresets)
  // MR-136: помним, открыл ли «Расширенные» сам пользователь. Тогда при возврате с Custom
  // на пресет панель НЕ схлопывается (авто-открытие только для Custom, ручное — держится).
  const [userOpened, setUserOpened] = useState(!hasPresets)

  // MR-136 (доработка MR-103): «Custom» — 4-й пресет (индекс 3). На сервере
  // PRESET_MUL[3] ?? 1 → ×1, поэтому Custom = задержки берутся как есть, без масштабирования.
  const CUSTOM = 3
  // Глобальный множитель ИИ-безопасности воркер применяет ко ВСЕМ задержкам — значит,
  // и обещанное здесь время обязано его учитывать, иначе панель врёт (созвон 19.08).
  const globalPace = useGlobalPace()
  const mul = (mulOverride ?? (PRESET_MUL[delayPreset] ?? 1)) * globalPace
  // Правка 14.08: значения Мин/Рекомендуемые/Макс — ЗАФИКСИРОВАНЫ. Пока выбран пресет темпа
  // (не Custom), все поля «Расширенных» заблокированы: раньше правка на пресете молча
  // перекидывала в Custom, из-за чего казалось, что пресеты «не держат» значения. Теперь
  // ручная правка — только в Custom, а пресеты всегда подставляют свои фиксированные числа.
  const onPreset = hasPresets && delayPreset !== CUSTOM
  // «Эффективная» задержка = базовая × множитель пресета — то, что реально уйдёт на паузы;
  // показываем её под карточками, чтобы выбор Мин/Рек/Макс СРАЗУ менял видимые значения.
  const eff = (pair?: [number, number] | null) => pair ? `${Math.round(pair[0] * mul)}–${Math.round(pair[1] * mul)} с` : null
  // Правка 14.08: под пресетами показываем ПОЛНОЕ (общее) время задачи одним числом, а не
  // два диапазона задержек. Считается как LaunchCost: действий-на-аккаунт × средняя задержка
  // между действиями (×множитель пресета). Совпадает с чипом времени внизу панели запуска.
  const fmtDur = (sec: number): string | null => {
    if (!sec || sec <= 0) return null
    const m = Math.round(sec / 60)
    if (m < 1) return `${Math.round(sec)} с`
    if (m < 60) return `${m} мин`
    const h = Math.floor(m / 60), r = m % 60
    return r ? `${h} ч ${r} мин` : `${h} ч`
  }
  // Правка 24.08: считаем ОДНОЙ формулой с нижней панелью запуска — раньше здесь стояло
  // «25 мин», а внизу «13 мин» для того же запуска. Общее число действий принимали за
  // «сколько сделает один аккаунт», хотя воркер делит его между аккаунтами.
  const totalActions = computedTotal?.value ?? perAccount?.max ?? 0
  const accountsCount = computedTotal?.accounts ?? 1
  const primaryDelay = (showAction && delays.action) ? delays.action : (showComment && delays.comment) ? delays.comment : (delays.action || delays.comment || null)
  const avgDelaySec = primaryDelay ? ((primaryDelay[0] + primaryDelay[1]) / 2) * mul : 0
  // Замечание владельца 26.08: «задержка вступления ни на что не влияет». Воркер её реально
  // спит (joinTarget.js), причём один раз на пару «аккаунт + цель», — значит она обязана
  // входить во время. Это верхняя оценка «первого захода»: уже вступивший аккаунт не платит.
  const avgJoinSec = (showJoin && delays.join) ? ((delays.join[0] + delays.join[1]) / 2) * mul : 0
  const joinTime = joinSeconds(targetsCount ?? 0, perAccountShare(totalActions, accountsCount), avgJoinSec)
  const actionsTime = taskSeconds(totalActions, accountsCount, avgDelaySec)
  const fullTime = fmtDur(actionsTime + joinTime)
  // MR-136: поля задержек показывают ЭФФЕКТИВНОЕ значение (базовое × множитель пресета) —
  // чтобы выбор Мин/Макс сразу менял видимые числа. При ручном правке уходим в Custom (×1),
  // и введённое (уже масштабированное) значение становится базовым — эффект сохраняется.
  const sc = (n: number) => Math.round(n * mul)
  // MR-136: авто-раскрытие «Расширенных» — только для Custom. На пресетах держим состояние,
  // которое задал сам пользователь (иначе после Custom панель оставалась открытой навсегда).
  useEffect(() => {
    if (!hasPresets) return
    setAdvanced(delayPreset === CUSTOM ? true : userOpened)
  }, [delayPreset, hasPresets, userOpened])
  // MR-136: ручной ввод любой задержки → авто-переключение на «Custom». Чтобы значения не
  // «прыгнули» (поля показывают масштабированные ×mul, а Custom = ×1), при переходе ЗАПЕКАЕМ
  // текущий множитель в базовые задержки — тогда видимые числа остаются те же.
  const editDelays = (updater: (d: DelaysShape) => DelaysShape) => {
    const goingCustom = hasPresets && delayPreset !== CUSTOM
    if (goingCustom) onDelayPreset!(CUSTOM)
    onDelays((d) => updater(goingCustom
      ? { ...d, comment: [sc(d.comment[0]), sc(d.comment[1])], action: [sc(d.action[0]), sc(d.action[1])], join: [sc(d.join[0]), sc(d.join[1])] }
      : d))
  }

  const timeMode = !!workModeOptions && workMode === 1
  const showDuration = showDurationAlways || timeMode
  const showCounts = !workModeOptions || !timeMode

  // Пресет темпа выставляет Длительность. Множитель к базовой (реком.) длительности:
  // Мин — короче (быстрее), Макс — дольше (безопаснее).
  const DUR_FACTOR = [0.75, 1, 1.5, 1]
  // Правка 14.08: НЕИЗМЕННАЯ база пресетов. Захватывается ОДИН раз при первом рендере и
  // больше НИКОГДА не мутируется. Раньше правка в Custom писала в baseRef — и значения
  // «протекали» в Мин/Рек/Макс (баг: пресеты переставали держать свои числа). Теперь
  // пресет всегда подставляет ровно эту базу, а Custom правит только текущее состояние.
  const frozen = useRef({
    dur: durationMinutes,
    limMin: perAccount?.min ?? 0,
    limMax: perAccount?.max ?? 0,
    delays: { ...delays },
  })
  const applyPresetExtras = (i: number) => {
    if (i === CUSTOM) return
    const b = frozen.current
    if (onDuration && showDuration) onDuration(Math.max(1, Math.round(b.dur * DUR_FACTOR[i])))
    // Лимит «Сколько действий сделает 1 аккаунт» НЕ масштабируется пресетом — одинаковый (базовый)
    // на Мин/Рек/Макс, меняется только в Custom. (Заказчик 14.08: «всюди 10, крім кастом».)
    if (perAccount) { perAccount.onMin(b.limMin); perAccount.onMax(b.limMax) }
    // Задержки — всегда из неизменной базы: любая правка в Custom не должна их сдвигать.
    onDelays(() => ({ ...b.delays }))
  }
  // Ручная правка Длительности/лимита возможна ТОЛЬКО в Custom (на пресетах поля заблокированы).
  // База (frozen) при этом НЕ трогается — поэтому возврат на пресет всегда даёт исходные числа.
  const editDuration = (v: number) => { if (hasPresets && delayPreset !== CUSTOM) onDelayPreset!(CUSTOM); onDuration?.(v) }
  const editPerAccount = (which: 'min' | 'max', v: number) => {
    if (hasPresets && delayPreset !== CUSTOM) onDelayPreset!(CUSTOM)
    if (which === 'min') perAccount?.onMin(v); else perAccount?.onMax(v)
  }

  const body = (
    <>
      {/* Пресет темпа — карточками, как «Защита аккаунтов». + «Custom» для ручных значений. */}
      {hasPresets && !hidePresets && (
        <>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[...delayPresets!, 'Custom'].map((label, i) => {
            const isCustom = i === CUSTOM
            const meta = isCustom
              ? { desc: 'Ручные значения задержек', icon: SlidersHorizontal, tooltip: 'Свои задержки: откроются «Расширенные настройки». Пресет темпа не масштабирует значения (×1) — работает ровно то, что задано.' }
              : (PRESET_META[i] ?? PRESET_META[1])
            const Icon = meta.icon
            const active = i === delayPreset
            return (
              <button
                key={label}
                type="button"
                // MR-136: раскрытие «Расширенных» для Custom делает эффект по delayPreset;
                // пресет также выставляет Длительность и лимит «Сколько действий сделает 1 аккаунт».
                onClick={() => {
                  // Вход в Custom из пресета: «запекаем» видимые (масштабированные ×mul)
                  // задержки в текущее состояние, чтобы числа не прыгнули (Custom = ×1).
                  // База (frozen) при этом не трогается.
                  if (i === CUSTOM && delayPreset !== CUSTOM) {
                    const m = PRESET_MUL[delayPreset] ?? 1
                    onDelays((d) => ({
                      ...d,
                      comment: d.comment ? [Math.round(d.comment[0] * m), Math.round(d.comment[1] * m)] : d.comment,
                      action: d.action ? [Math.round(d.action[0] * m), Math.round(d.action[1] * m)] : d.action,
                      join: d.join ? [Math.round(d.join[0] * m), Math.round(d.join[1] * m)] : d.join,
                    }))
                  }
                  onDelayPreset!(i); applyPresetExtras(i)
                }}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border p-3 text-left transition-all',
                  active ? 'border-spark-500/60 bg-spark-500/10' : 'border-line bg-elevated hover:border-spark-500/30',
                )}
              >
                <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', active ? 'bg-spark-500/20 text-spark-300' : 'text-muted')}>
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  {/* §8: у каждого пресета — маленькая подсказка «?», как у режимов «Защиты». */}
                  <div className="flex items-center gap-1.5">
                    <span className={cn('text-sm font-bold', active ? 'text-fg' : 'text-muted')}>{label}</span>
                    {meta.tooltip && <InfoTip text={meta.tooltip} />}
                  </div>
                  <div className="text-[11px] leading-snug text-muted">{meta.desc}</div>
                </div>
              </button>
            )
          })}
        </div>
        {/* Правка 14.08: ПОЛНОЕ время задачи одним числом (а не два диапазона задержек).
            Если посчитать не из чего (нет действий/задержки) — падаем на эффективные задержки. */}
        <div className="mt-2 text-[11px] text-muted">
          {fullTime
            ? <>Полное время: ≈ {fullTime} <span className="text-faint">({accountsCount > 1 ? `${accountsCount} аккаунта работают параллельно` : 'один аккаунт'}{delayPreset === CUSTOM ? '' : `, пресет «${delayPresets![delayPreset]}»`})</span>
              {/* Из чего сложилось: без разбивки было непонятно, почему число не двигается
                  от задержки вступления (замечание владельца 26.08). */}
              {joinTime > 0 && (
                <span className="text-faint"> · действия {fmtDur(actionsTime)} + вступления {fmtDur(joinTime)} (первый заход)</span>
              )}
              {/* Целей нет — вступать некуда, и правка «Задержки вступления» ничего не
                  двигает. Молчать об этом нельзя: поле выглядит сломанным (замечание 26.08). */}
              {joinTime === 0 && avgJoinSec > 0 && !targetsCount && (
                <span className="text-faint"> · вступления посчитаем, когда добавите цель</span>
              )}</>
            : delayPreset === CUSTOM
              ? <>Задержки — ручные (заданы в «Расширенных настройках»).</>
              : <>Эффективные задержки: {[showAction && delays.action && `действие ${eff(delays.action)}`, showComment && delays.comment && `комментарий ${eff(delays.comment)}`, showJoin && delays.join && `вступление ${eff(delays.join)}`].filter(Boolean).join(' · ') || '—'}</>}
        </div>
        </>
      )}

      {/* Расширенные настройки — режим работы, лимиты, точные задержки. */}
      {hasPresets && (
        <button
          type="button"
          onClick={() => { const nv = !advanced; setAdvanced(nv); setUserOpened(nv) }}
          className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-muted transition-colors hover:text-fg"
        >
          <ChevronRight size={15} className={cn('transition-transform', advanced && 'rotate-90')} />
          Расширенные настройки
        </button>
      )}

      {advanced && (
        // Правка 14.08: «Расширенные» ВСЕГДА активны (не блокируем). На пресете видны его
        // значения; изменил любое — автоматически переключает на Custom, а возврат на пресет
        // сбрасывает всё на дефолт (frozen). Раньше поля были заблокированы — заказчик просил снять.
        <div className={cn('space-y-4', hasPresets && 'mt-3')}>
          {onPreset && (
            <div className="flex items-center gap-1.5 rounded-lg border border-line bg-elevated px-3 py-2 text-[11px] text-muted">
              <Shield size={13} className="shrink-0 text-spark-300" />
              Значения пресета «{delayPresets![delayPreset]}». Измените любое поле — переключится на «Custom».
            </div>
          )}
          {/* Режим работы + лимиты — ОБЪЁМ задачи. В «Параметрах и лимитах». */}
          {part !== 'delays' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
              {workModeOptions && onWorkMode && (
                <ToggleGroup label={workModeLabel} options={workModeOptions} value={workMode} onChange={onWorkMode} />
              )}
              {showDuration && onDuration && (
                <div>
                  <NumberField label="Длительность (мин)" value={durationMinutes} onChange={editDuration} suffix={`${durationMinutes}m`} />
                  {durationPeriodHint && <p className="mt-1 text-xs text-muted">{durationPeriodHint}</p>}
                </div>
              )}
              {showCounts && computedTotal ? (
                <div>
                  <div className="mb-1 text-sm text-muted">{totalLabel} — авто</div>
                  <div className="rounded-xl border border-line bg-elevated px-3 py-2.5">
                    <div className="font-display text-lg font-bold text-fg">≈ {computedTotal.value}</div>
                    <div className="text-[11px] text-muted">на 1 аккаунт × {computedTotal.accounts} акк.</div>
                  </div>
                  {computedTotal.accounts <= 1 && (
                    <p className="mt-1 text-[11px] text-amber-300">Выбран 1 аккаунт — вся нагрузка ляжет на него. Добавьте аккаунты, чтобы распределить.</p>
                  )}
                </div>
              ) : showCounts && total ? (
                <MinMaxField label={totalLabel} min={total.min} max={total.max} onMin={total.onMin} onMax={total.onMax} />
              ) : null}
            </div>

            <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
              {/* «для цели» здесь означало целевое ДЕЙСТВИЕ — сколько раз аккаунт
                  прокомментирует, поставит реакцию и т. д. Но «цель» в платформе — отдельная
                  сущность (цель кампании, `goalId`, со своей базой знаний и критерием
                  завершения), и одно слово на два понятия путало прямо в форме запуска.
                  Подпись приведена к словарю парного поля выше — оно называется «Всего
                  действий», значит здесь тоже действия. */}
              {perAccount && (
                <MinMaxField label={computedTotal ? 'Сколько действий сделает 1 аккаунт' : 'На аккаунт'} min={perAccount.min} max={perAccount.max} onMin={(v) => editPerAccount('min', v)} onMax={(v) => editPerAccount('max', v)} />
              )}
              {minWords && (
                <NumberField label="Мин. слов в посте" value={minWords.value} onChange={minWords.onChange} />
              )}
              {!perAccount && !minWords && (
                <p className="text-sm text-muted">Лимиты применяются на сервере с учётом защиты аккаунтов.</p>
              )}
            </div>
          </div>
          )}

          {/* Задержки — ТЕМП. В «Защите и таймингах». */}
          {part !== 'limits' && (
          <div className="rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="mb-2 text-sm font-bold text-fg">Задержки</div>
            <div className="space-y-3">
              {showComment && delays.comment && (
                <DelayFields
                  label={labels.comment ?? 'Задержка комментария'}
                  from={sc(delays.comment[0])} to={sc(delays.comment[1])}
                  onFrom={(n) => editDelays((d) => ({ ...d, comment: [n, d.comment?.[1] ?? n] }))}
                  onTo={(n) => editDelays((d) => ({ ...d, comment: [d.comment?.[0] ?? n, n] }))}
                  unit="с"
                />
              )}
              {showAction && delays.action && (
                <DelayFields
                  label={labels.action ?? 'Задержка действия'}
                  from={sc(delays.action[0])} to={sc(delays.action[1])}
                  onFrom={(n) => editDelays((d) => ({ ...d, action: [n, d.action?.[1] ?? n] }))}
                  onTo={(n) => editDelays((d) => ({ ...d, action: [d.action?.[0] ?? n, n] }))}
                  unit="с"
                />
              )}
              {showJoin && delays.join && (
                <DelayFields
                  label={labels.join ?? 'Задержка вступления'}
                  from={sc(delays.join[0])} to={sc(delays.join[1])}
                  onFrom={(n) => editDelays((d) => ({ ...d, join: [n, d.join?.[1] ?? n] }))}
                  onTo={(n) => editDelays((d) => ({ ...d, join: [d.join?.[0] ?? n, n] }))}
                  unit="с"
                />
              )}
              {/* Обе настройки — аварийная ветка: срабатывают, только когда Telegram
                  притормозил аккаунт. Поэтому в обещанное время они НЕ входят, но на
                  реальный прогон влияют (server/lib/accountRunner.js#handleFlood).
                  Подпись об этом говорит прямо — иначе поля выглядят мёртвыми. */}
              <SingleDelayField
                label="FloodWait задержка (сек)"
                hint="Сколько ждать сверх срока, который назвал Telegram. Срабатывает только при FloodWait — в расчёт времени задачи не входит."
                value={delays.floodWait}
                onChange={(n) => editDelays((d) => ({ ...d, floodWait: n }))}
                unit="с"
              />
              {/*
                Это СЧЁТЧИК срабатываний, а не секунды. Потолка не было — можно было
                вписать 5000 и тем самым выключить карантин совсем (замечание владельца
                26.08). Ноль тоже нельзя: `floodWaits >= 0` отправил бы в карантин с
                первого же FloodWait.
              */}
              <SingleDelayField
                label="FloodWait до карантина"
                hint="Сколько FloodWait подряд аккаунт переживёт, прежде чем уйдёт в карантин. Это счётчик, не секунды."
                value={delays.floodQuarantine}
                onChange={(n) => editDelays((d) => ({ ...d, floodQuarantine: n }))}
                min={1}
                max={10}
              />
            </div>
          </div>
          )}
        </div>
      )}
    </>
  )
  if (bare) {
    // Подзаголовок нужен только там, где блок про ТЕМП. В «Параметрах и лимитах»
    // рисуется объём задачи, и «Тайминги и задержки» над ним просто врали (правка 19.08).
    // Подзаголовка нет: карточка уже называется «Защита и тайминги», а в «Параметрах и
    // лимитах» этот блок про объём — в обоих случаях надпись только повторяла заголовок
    // или врала (правка 19.08).
    return <div className={part === 'limits' ? 'mt-3' : ''}>{body}</div>
  }
  return <SectionCard icon={<Timer size={18} />} title="Тайминги и задержки">{body}</SectionCard>
}
