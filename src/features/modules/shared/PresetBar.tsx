import { useEffect, useRef, useState } from 'react'
import { Bookmark, Pencil, Plus, X } from 'lucide-react'
import type { ModulePreset, ModuleTaskSettings } from '@/api/modulesApi'
import { presetHex } from './SavePresetModal'
import { cn } from '@/shared/lib/utils'

/**
 * Шаблоны настроек модуля (ТЗ 06.08 §10, TPL-001).
 *
 * Общий здесь только ВИД: список шаблонов у каждого модуля свой — он приходит из
 * `useModuleTask(moduleKey)`, хранится под ключом модуля и в другой модуль не подставляется.
 * Настройки нейрокомментинга в мейлинге бессмысленны, смешивать их нельзя.
 *
 * ТЗ: «Выбор и сохранение шаблона доступны без прокрутки: в начале модуля или в нижней
 * панели. В каждом модуле должен быть выбор шаблона». Делаем ОБА места:
 *
 * - `PresetBar` — полоса ПЕРЕД всеми настройками: применил шаблон → дальше правишь уже
 *   подставленное, а не заполняешь всё заново, обнаружив шаблоны внизу страницы.
 *   Показывается, только когда в модуле есть хотя бы один сохранённый шаблон.
 * - `PresetMenu` — кнопка «Шаблон» в нижнем баре: выбрать существующий или, если их ещё
 *   нет, создать первый. Здесь и живёт пустое состояние — оно под кликом и места не занимает.
 *
 * Раньше выбора не было вообще: кнопка умела только сохранять, а список применения рисовался
 * внизу и лишь при `presets.length > 0`.
 */
type PresetProps = {
  presets?: ModulePreset[]
  onApply?: (settings: ModuleTaskSettings) => void
  /** Открывает модалку сохранения текущих настроек (имя, цвет, владелец). */
  onSave: () => void
  onEdit?: (p: ModulePreset) => void
  onDelete?: (id: string) => void
  /** Во время работы задачи настройки менять нельзя — применение блокируем. */
  disabled?: boolean
}

export function PresetBar({ presets = [], onApply, onSave, onEdit, onDelete, disabled }: PresetProps) {
  // Пока шаблонов нет — полосы вверху НЕТ (правка 18.08): она занимала бы место в шапке
  // модуля ради строки «у вас нет шаблонов». Создать первый можно из меню кнопки
  // «Шаблон» внизу — там пустое состояние уместно, оно раскрывается по клику.
  if (presets.length === 0) return null
  return (
    <div className="rounded-2xl border border-line bg-elevated/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
          <Bookmark size={13} /> Шаблоны настроек
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {presets.map((p) => (
            /*
             * Правка 26.08: кликабельна ВСЯ плашка, а не только название.
             * Раньше нажатие ловил один <button> с текстом — попасть надо было точно в
             * буквы: мимо по цветной точке, по подписи владельца или просто по отступу
             * клик не срабатывал, и человек считал, что шаблон не применяется.
             *
             * Карандаш и крестик остаются отдельными кнопками и гасят всплытие: иначе
             * «переименовать» или «удалить» заодно подставляли бы настройки.
             * Плашка — не <button>, потому что кнопка внутри кнопки — невалидная разметка;
             * поэтому role/tabIndex и обработка Enter и пробела руками.
             */
            <span
              key={p.id}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-label={`Применить шаблон «${p.name}»`}
              title="Применить шаблон к настройкам"
              onClick={() => { if (!disabled) onApply?.(p.settings) }}
              onKeyDown={(e) => {
                if (disabled || (e.key !== 'Enter' && e.key !== ' ')) return
                e.preventDefault()
                onApply?.(p.settings)
              }}
              className={cn(
                'group inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface py-1.5 pl-2.5 pr-1.5 text-sm font-medium text-fg transition-all',
                // Нажатие должно быть ВИДНО: настройки подставляются мгновенно, и без
                // отклика человек не понимал, сработал ли клик, и жал по второму разу.
                disabled
                  ? 'cursor-default opacity-50'
                  : 'cursor-pointer hover:border-spark-500/40 active:scale-95 active:border-spark-500/70 active:bg-spark-500/10',
              )}
              style={{ borderLeft: `3px solid ${presetHex(p.color)}` }}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: presetHex(p.color) }} />
              <span className="max-w-[180px] truncate text-left">{p.name}</span>
              {p.owner && (
                <span className="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted" title="Владелец шаблона">
                  {p.owner}
                </span>
              )}
              {onEdit && (
                <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(p) }} title="Переименовать шаблон"
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-lg text-faint hover:bg-spark-500/12 hover:text-spark-300">
                  <Pencil size={12} />
                </button>
              )}
              {onDelete && (
                <button type="button" onClick={(e) => {
                  e.stopPropagation()
                  // Шаблоны — ОБЩИЙ набор рабочего пространства, а не личная папка:
                  // удаляют не только у себя. Крестик стоит вплотную к самому шаблону,
                  // и одного промаха хватало, чтобы чужая настройка исчезла у всех
                  // без следа и без возможности вернуть.
                  if (!window.confirm(`Удалить шаблон «${p.name}»? Он общий для рабочего пространства — пропадёт у всех, и собирать настройки придётся заново.`)) return
                  onDelete(p.id)
                }} title="Удалить шаблон"
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-lg text-faint hover:bg-rose-500/12 hover:text-rose-300">
                  <X size={13} />
                </button>
              )}
            </span>
          ))}
        </div>
        <button type="button" onClick={onSave} className="btn-ghost ml-auto h-8 shrink-0 text-xs" title="Сохранить текущие настройки как новый шаблон">
          <Plus size={14} /> Создать новый шаблон
        </button>
      </div>
      {/* Правка 26.08: аккаунты шаблон теперь и восстанавливает, а не только сохраняет —
          подпись обязана говорить правду, иначе она сама сбивает с толку. */}
      <p className="mt-1.5 text-xs text-muted">Клик по шаблону — подставить сохранённые настройки вместе с выбором аккаунтов. Недоступных в подстановку не берём.</p>
    </div>
  )
}

/** Кнопка «Шаблон» в нижнем баре: выбрать существующий или создать первый. */
export function PresetMenu({ presets = [], onApply, onSave, disabled }: PresetProps) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // Клик мимо и Esc закрывают меню: оно висит над плавающим баром и иначе перекрывает «Начать».
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])

  const empty = presets.length === 0
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} title="Выбрать или сохранить шаблон настроек" className="btn-ghost h-10 text-sm">
        <Bookmark size={15} /> Шаблон
        {!empty && <span className="rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-bold text-muted">{presets.length}</span>}
      </button>
      {open && (
        // Меню раскрывается ВВЕРХ (bottom-full): бар прижат ко дну экрана, вниз места нет.
        <div className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-2xl border border-line bg-surface p-2 shadow-xl">
          {empty ? (
            <>
              <p className="px-2 py-1.5 text-sm text-muted">У вас нет шаблонов</p>
              <button type="button" onClick={() => { setOpen(false); onSave() }} className="btn-ghost h-9 w-full justify-start text-sm">
                <Plus size={14} /> Создать шаблон
              </button>
            </>
          ) : (
            <>
              <p className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-wide text-faint">Применить шаблон</p>
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { setOpen(false); onApply?.(p.settings) }}
                    disabled={disabled}
                    className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm text-fg hover:bg-elevated disabled:opacity-50"
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: presetHex(p.color) }} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {p.owner && <span className="shrink-0 text-[10px] uppercase text-faint">{p.owner}</span>}
                  </button>
                ))}
              </div>
              <div className="mt-1 border-t border-line pt-1">
                <button type="button" onClick={() => { setOpen(false); onSave() }} className="btn-ghost h-9 w-full justify-start text-sm">
                  <Plus size={14} /> Создать новый шаблон
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
