import { Play, AlertTriangle, Loader2, ArrowUpRight } from 'lucide-react'
import type { ModuleTask, ModulePreset, ModulePresetSettings } from '@/api/modulesApi'
import { FloatingBar } from './FloatingBar'
import { PresetMenu } from './PresetBar'
import { cn } from '@/shared/lib/utils'

export function LaunchPanel({
  running, starting, canStart, onStart, onSave, primaryLabel, warn, cost, stats,
  presets, onApplyPreset, extras, steps, blockedBy = [], notify,
}: {
  running: boolean; starting: boolean; canStart: boolean
  onStart: () => void; onStop?: () => void; onSave: () => void
  primaryLabel: string
  /** Компактные шаги запуска — строкой ПОД кнопкой, внутри самой панели. */
  steps?: React.ReactNode
  /** Что мешает запуску: показываем рядом с серой кнопкой, чтобы не гадать. */
  blockedBy?: string[]
  /** Сводка модуля: рисуется В ПОТОКЕ над панелью (кнопки живут в плавающем баре). */
  stats?: { icon: React.ReactNode; color: string; label: string; value: string; warn?: boolean }[]
  task: ModuleTask | null
  warn?: string
  /** §5.1: во сколько обойдётся запуск — показываем ДО кнопки, а не по факту списания. */
  cost?: React.ReactNode
  /** Шаблоны ЭТОГО модуля — для меню на кнопке «Шаблон». Список рисует `PresetBar` вверху. */
  presets?: ModulePreset[]
  onApplyPreset?: (settings: ModulePresetSettings) => void
  /**
   * Доп. блоки запуска (расписание, ссылка на логи). Рендерятся В ПОТОКЕ, ПЕРЕД плавающим
   * баром: сам бар обязан быть последним элементом, иначе его заглушка резервирует место
   * в середине, а бар висит внизу экрана поверх этого контента — та самая «двойная плашка».
   */
  extras?: React.ReactNode
  /**
   * MR-251: уведомления о статусе ЗАДАЧИ — здесь, у запуска, и включены по умолчанию.
   *
   * Владелец 30.08: «Прогрев не имеет вообще никакого отношения к уведомлениям. Они имеют
   * отношение только к задаче. Это должно быть там, где запуск задачи, и включено по
   * умолчанию». Раньше галочка лежала внутри «Защиты и таймингов» и внутри блока прогрева —
   * то есть в настройках модуля, хотя относится к запускаемой задаче.
   */
  notify?: { on: boolean; onChange: (v: boolean) => void }
}) {
  return (
    <>
      {/*
        Сводка запуска (правка 26.08). 13.08 её убрали из панели — панель уехала в
        плавающий бар внизу, и рисовать там широкие плитки было негде. Но модули
        продолжали её СЧИТАТЬ и передавать, а карточка «Параметры и лимиты», где она
        жила, осталась пустой коробкой с заголовком: у мейлинга и автопостинга обёртку
        просто сняли, а у парсеров, живых модулей и нейродиалогов — нет.
        Возвращаем сюда, в поток: карточка снова про то, что обещает названием, а числа,
        которые и так считаются, видно перед запуском.
      */}
      {stats && stats.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stats.map((st) => (
            <div key={st.label} className="flex items-center gap-2.5 rounded-xl border border-line bg-elevated/40 px-3 py-2.5">
              <span className="shrink-0" style={{ color: st.warn ? '#f43f5e' : st.color }}>{st.icon}</span>
              <span className="min-w-0">
                <span className="block truncate text-[11px] uppercase tracking-wide text-white/40">{st.label}</span>
                <span className={cn('block text-sm font-bold', st.warn ? 'text-rose-300' : 'text-fg')}>{st.value}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {/* Уведомления — последней строкой перед кнопками: это про запуск, а не про модуль. */}
      {notify && !running && (
        <label className="mb-3 flex cursor-pointer items-start gap-2 rounded-xl border border-line/60 bg-elevated/40 px-3 py-2.5">
          <input type="checkbox" checked={notify.on} onChange={(e) => notify.onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-spark-500" />
          <span>
            <span className="text-xs font-semibold text-fg">Уведомлять о статусе задачи</span>
            <span className="mt-0.5 block text-[11px] text-white/45">Ошибка или пауза этой задачи попадут в колокольчик. Снимите, если уведомления по ней не нужны.</span>
          </span>
        </label>
      )}
      {extras}
      {/* Плавающий бар — ПОСЛЕДНИЙ элемент: его заглушка резервирует место в самом низу
          карточки, ничего не рендерится ниже, и бар чисто «отрывается» ко дну экрана. */}
      {/* §4 (UI-001): вся сводка запуска живёт В САМОЙ ПАНЕЛИ компактными чипами —
          раньше она была широкими плитками выше по странице, и до кнопки «Начать»
          приходилось помнить, что там было. Детали цены — в подсказке. */}
      <FloatingBar>
        {/* Раскладка «лево — центр — право»: сводка прижата к левому краю, кнопки — к
            правому, дорожная карта РАСТЯГИВАЕТСЯ (flex-1) на всё оставшееся место. Так
            длинная подсказка «Осталось: …» встаёт в ОДНУ строку (а не переносится и не
            задирает высоту), а по бокам появляется воздух. На узких экранах — flex-wrap. */}
        <div className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2">
          {/* Сводка (лево): только ЦЕНА и ВРЕМЯ — крупными плашками, как кнопки справа.
              Чипы «Аккаунты / Группы / Лимит» убраны (правка заказчика 13.08): выбранные
              аккаунты и цели человек только что задал выше по странице, дублировать их в
              панели незачем — а вот «сколько спишется» и «сколько ждать» видно только здесь. */}
          <div className="flex shrink-0 items-center gap-2">
            {!running && cost}
          </div>

          {/* Дорожная карта (центр): растягивается на всё свободное место; подсказка —
              строкой под шагами, теперь ей хватает ширины на одну строку. */}
          <div className="flex min-w-0 flex-1 basis-64 flex-col items-center gap-0.5">
            {steps}
            {!running && (blockedBy.length > 0 || warn) && (
              <span className="inline-flex max-w-full items-center gap-1.5 text-center text-[11px] leading-tight text-amber-300">
                <AlertTriangle size={12} className="shrink-0" />
                {blockedBy.length ? `Осталось: ${blockedBy.join(' · ')}` : warn}
              </span>
            )}
          </div>

          {/* Кнопки (право): «Сохранить шаблон» и «Начать» рядом, у правого края. */}
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {running && (
              <a href="/panel/tasks" className="btn-ghost h-10 text-sm" title="Управление, прогресс и логи — в Дашборде задач"><ArrowUpRight size={15} /> В Дашборде задач</a>
            )}
            {/* «Шаблон» = выбрать ИЛИ создать (правка 18.08). Кнопка умела только сохранять,
                поэтому у пользователя без шаблонов выбор было негде взять. */}
            <PresetMenu presets={presets} onApply={onApplyPreset} onSave={onSave} disabled={running} />
            <button
              type="button"
              onClick={onStart}
              disabled={starting || !canStart}
              title={!canStart && blockedBy.length ? `Осталось: ${blockedBy.join('; ')}` : undefined}
              className="btn-primary h-10 min-w-[130px]"
            >
              {starting ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} />} {primaryLabel}
            </button>
          </div>
        </div>
      </FloatingBar>
    </>
  )
}
