import { Filter } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { dedupeText, type DedupeMode } from '@/shared/lib/dedupe'

/**
 * Кнопка «Отсеять дубли» для текстового списка. Одна на все модули: списки целей
 * везде устроены одинаково, и заводить свою кнопку в каждом экране незачем.
 *
 * Ничего не делает молча: если дублей нет — так и говорит, если убрала — пишет сколько.
 */
export function DedupeButton({ value, onChange, mode = 'exact', className }: {
  value: string
  onChange: (next: string) => void
  /** phone — сравнивать по цифрам, handle — по юзернейму без @ и t.me/, exact — как есть. */
  mode?: DedupeMode
  className?: string
}) {
  const pushToast = useApp((s) => s.pushToast)

  const run = () => {
    const r = dedupeText(value, mode)
    if (!r.removed) {
      pushToast({ type: 'info', title: 'Дублей нет', desc: `${r.kept} строк — все уникальные` })
      return
    }
    onChange(r.text)
    pushToast({ type: 'success', title: `Убрано дублей: ${r.removed}`, desc: `Осталось ${r.kept}` })
  }

  return (
    <button type="button" onClick={run} disabled={!value.trim()} className={className || 'btn-soft h-8 text-xs disabled:opacity-40'}>
      <Filter size={13} /> Отсеять дубли
    </button>
  )
}
