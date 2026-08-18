import { Play, AlertTriangle, Loader2, ArrowUpRight } from 'lucide-react'
import type { ModuleTask, ModulePreset, ModuleTaskSettings } from '@/api/modulesApi'
import { FloatingBar } from './FloatingBar'
import { PresetMenu } from './PresetBar'

export function LaunchPanel({
  running, starting, canStart, onStart, onSave, primaryLabel, warn, cost,
  presets, onApplyPreset, extras, steps, blockedBy = [],
}: {
  running: boolean; starting: boolean; canStart: boolean
  onStart: () => void; onStop?: () => void; onSave: () => void
  primaryLabel: string
  /** Компактные шаги запуска — строкой ПОД кнопкой, внутри самой панели. */
  steps?: React.ReactNode
  /** Что мешает запуску: показываем рядом с серой кнопкой, чтобы не гадать. */
  blockedBy?: string[]
  /** Сводка модуля. Панель её БОЛЬШЕ НЕ РИСУЕТ (правка 13.08) — оставлено, чтобы не
   *  переписывать вызовы во всех модулях; данные для неё они и так считают для себя. */
  stats?: { icon: React.ReactNode; color: string; label: string; value: string; warn?: boolean }[]
  task: ModuleTask | null
  warn?: string
  /** §5.1: во сколько обойдётся запуск — показываем ДО кнопки, а не по факту списания. */
  cost?: React.ReactNode
  /** Шаблоны ЭТОГО модуля — для меню на кнопке «Шаблон». Список рисует `PresetBar` вверху. */
  presets?: ModulePreset[]
  onApplyPreset?: (settings: ModuleTaskSettings) => void
  /**
   * Доп. блоки запуска (расписание, ссылка на логи). Рендерятся В ПОТОКЕ, ПЕРЕД плавающим
   * баром: сам бар обязан быть последним элементом, иначе его заглушка резервирует место
   * в середине, а бар висит внизу экрана поверх этого контента — та самая «двойная плашка».
   */
  extras?: React.ReactNode
}) {
  return (
    <>
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
