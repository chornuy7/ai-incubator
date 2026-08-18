import { useEffect, useRef, useState } from 'react'
import { Bookmark, Pencil, Plus, Save, X } from 'lucide-react'
import type { ModulePreset, ModuleTaskSettings } from '@/api/modulesApi'
import { presetHex } from './SavePresetModal'

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
 * - `PresetMenu` — та же кнопка «Шаблон» в нижнем баре, но теперь с выбором, а не только
 *   сохранением.
 *
 * Пустое состояние показываем ЯВНО («шаблонов нет — создать»), а не прячем блок: раньше
 * полоса рендерилась только при `presets.length > 0`, поэтому у нового пользователя кнопка
 * «Шаблон» умела лишь сохранять, и выбор было негде взять.
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
  const empty = presets.length === 0
  return (
    <div className="rounded-2xl border border-line bg-elevated/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
          <Bookmark size={13} /> Шаблоны настроек
        </span>
        {empty ? (
          <>
            <span className="text-sm text-muted">У вас нет шаблонов</span>
            <button type="button" onClick={onSave} className="btn-ghost ml-auto h-8 text-xs">
              <Plus size={14} /> Создать шаблон
            </button>
          </>
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {presets.map((p) => (
                <span
                  key={p.id}
                  className="group inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface py-1.5 pl-2.5 pr-1.5 text-sm font-medium text-fg transition-colors hover:border-spark-500/40"
                  style={{ borderLeft: `3px solid ${presetHex(p.color)}` }}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: presetHex(p.color) }} />
                  <button
                    type="button"
                    onClick={() => onApply?.(p.settings)}
                    disabled={disabled}
                    title="Применить шаблон к настройкам"
                    className="max-w-[180px] truncate text-left disabled:opacity-50"
                  >
                    {p.name}
                  </button>
                  {p.owner && (
                    <span className="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted" title="Владелец шаблона">
                      {p.owner}
                    </span>
                  )}
                  {onEdit && (
                    <button type="button" onClick={() => onEdit(p)} title="Переименовать шаблон"
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-lg text-faint hover:bg-spark-500/12 hover:text-spark-300">
                      <Pencil size={12} />
                    </button>
                  )}
                  {onDelete && (
                    <button type="button" onClick={() => onDelete(p.id)} title="Удалить шаблон"
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-lg text-faint hover:bg-rose-500/12 hover:text-rose-300">
                      <X size={13} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <button type="button" onClick={onSave} className="btn-ghost ml-auto h-8 shrink-0 text-xs" title="Сохранить текущие настройки как новый шаблон">
              <Save size={14} /> Сохранить текущие
            </button>
          </>
        )}
      </div>
      {!empty && <p className="mt-1.5 text-xs text-muted">Клик по названию — подставить сохранённые настройки. Выбор аккаунтов не меняется.</p>}
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
                  <Save size={14} /> Сохранить текущие настройки
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
