import { useState } from 'react'
import { Clock } from 'lucide-react'
import { Segmented, NumberField } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { createAutomationRule } from '@/api/automationApi'

/**
 * «Запуск по расписанию» — создать правило автоматизации с текущими настройками
 * модуля, не запуская его сейчас.
 *
 * Раньше этот блок жил только внутри LiveModule, поэтому расписание было доступно
 * в нейрокомментинге, нейрочатинге, реакциях, масслукинге, прогреве и AIR — и
 * отсутствовало во ВСЕХ пяти парсерах и в НейроДиалогах, которые рисуются другими
 * компонентами (прогон 21–22.07, тест 6.13). Вынесено сюда, чтобы подключаться
 * одной строкой в любом модуле.
 */
export function SchedulePanel({
  moduleKey,
  title,
  buildSettings,
  accountIds,
  campaignId,
  campaignName,
  disabled,
  disabledReason,
}: {
  moduleKey: string
  /** Заголовок модуля — попадёт в имя правила. */
  title: string
  /** Настройки модуля на момент создания правила. */
  buildSettings: () => Record<string, unknown>
  accountIds: string[]
  campaignId?: string | null
  campaignName?: string
  /** Нельзя создать правило (модуль ещё не настроен). */
  disabled?: boolean
  disabledReason?: string
}) {
  const pushToast = useApp((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(0)
  const [at, setAt] = useState('')
  const [time, setTime] = useState('10:00')
  const [every, setEvery] = useState(60)
  const [saving, setSaving] = useState(false)

  const create = async () => {
    if (disabled) return pushToast({ type: 'error', title: 'Сначала настройте запуск', desc: disabledReason })
    if (mode === 0 && (!at || Number.isNaN(new Date(at).getTime()))) {
      return pushToast({ type: 'error', title: 'Укажите дату и время запуска' })
    }
    const schedule = mode === 0
      ? { type: 'once' as const, at: new Date(at).getTime() }
      : mode === 1
        ? { type: 'daily' as const, time }
        : { type: 'interval' as const, intervalMinutes: Math.max(1, every) }
    setSaving(true)
    try {
      await createAutomationRule({
        name: `${title}${campaignName ? ` · ${campaignName}` : ''}`,
        moduleKey,
        campaignId: campaignId || null,
        accountIds,
        settings: buildSettings(),
        schedule,
      })
      pushToast({ type: 'success', title: 'Правило автоматизации создано', desc: 'Смотрите в разделе «Автоматизация»' })
      setOpen(false)
    } catch (e) {
      pushToast({ type: 'error', title: 'Не создано', desc: e instanceof Error ? e.message : '' })
    } finally { setSaving(false) }
  }

  return (
    <div className="mt-3 rounded-xl border border-line bg-elevated/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-muted hover:text-fg"
      >
        <Clock size={15} className="text-iris-300" />
        Запуск по расписанию
        <span className="text-xs font-normal text-faint">— создать правило, не запуская сейчас</span>
        <span className="ml-auto text-xs text-faint">{open ? 'скрыть ▲' : 'настроить ▾'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 pb-3 pt-3">
          <Segmented options={['Однократно', 'Ежедневно', 'Каждые N минут']} value={mode} onChange={setMode} size="sm" />
          {mode === 0 && (
            <div>
              <div className="mb-1 text-xs text-white/50">Дата и время запуска</div>
              <input type="datetime-local" className="input h-9" value={at} onChange={(e) => setAt(e.target.value)} />
              {/* Поле рисуется браузером и в локали en-US показывает AM/PM, тогда как весь
                  интерфейс 24-часовой — подписываем, что реально сохранится (ср. тест 10.3-a). */}
              {at && !Number.isNaN(new Date(at).getTime()) && (
                <span className="mt-1 block text-[11px] text-iris-300">
                  Запустится: {new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                </span>
              )}
            </div>
          )}
          {mode === 1 && (
            <div>
              <div className="mb-1 text-xs text-white/50">Время ежедневного запуска</div>
              <input type="time" className="input h-9 w-32" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
          {mode === 2 && (
            <div>
              <div className="mb-1 text-xs text-white/50">Интервал (минуты)</div>
              <NumberField value={every} onChange={setEvery} min={1} className="input mt-0 h-9 w-32" />
            </div>
          )}
          <p className="text-[11px] text-white/40">
            Правило заберёт текущие настройки модуля{campaignId ? ' и кампанию' : ''}. Управление — в разделе «Автоматизация».
          </p>
          <button
            type="button"
            onClick={() => void create()}
            disabled={saving || disabled}
            className="btn-ghost h-9 text-sm disabled:opacity-40"
          >
            <Clock size={14} /> {saving ? 'Создание…' : 'Создать правило'}
          </button>
          {disabled && disabledReason && <p className="text-[11px] text-amber-300">{disabledReason}</p>}
        </div>
      )}
    </div>
  )
}
