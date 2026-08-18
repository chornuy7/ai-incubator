import { useMemo, useState } from 'react'
import { Search, Users } from 'lucide-react'
import { Avatar, StatusBadge } from '@/shared/ui'
import { STATUS_META } from '@/mocks/store'
import type { TgAccount } from '@/shared/types'
import { cn } from '@/shared/lib/utils'

/**
 * Как назвать аккаунт, у которого Telegram не отдал имя.
 *
 * Импорт сессий заполняет имя только когда профиль удалось прочитать; у остальных
 * в списке оставался сырой `acc_018eaaa58e0d` — по такой стене одинаковых строк
 * невозможно найти нужный. Спускаемся по тому, что человек реально узнаёт:
 * имя → @username → телефон → короткий id.
 */
/** У импортированных аккаунтов пустые поля хранятся как «—» — это не значение. */
const val = (v?: string) => {
  const s = (v || '').trim()
  return s && s !== '—' ? s : ''
}

export function accountLabel(a: TgAccount): string {
  const name = val(a.name)
  // Имя вида «acc_018eaaa58e0d» — это не имя, а тот же id.
  if (name && !/^acc_[0-9a-f]{6,}$/i.test(name)) return name
  if (val(a.username)) return `@${val(a.username)}`
  if (val(a.phone)) return val(a.phone)
  return `#${a.id.slice(-6)}`
}

/** Вторая строка: то, чего нет в первой, — чтобы строки не дублировались. */
export function accountSub(a: TgAccount): string {
  const parts: string[] = []
  const label = accountLabel(a)
  const u = val(a.username)
  const ph = val(a.phone)
  if (u && label !== `@${u}`) parts.push(`@${u}`)
  if (ph && label !== ph) parts.push(ph)
  // Короткий id показываем, только если его ещё не видно в первой строке: у
  // импортированных юзернейм и так собран из него («@user_0101cb» / «#0101cb»).
  const tail = a.id.slice(-6)
  if (!parts.length && !label.includes(tail)) parts.push(`#${tail}`)
  return parts.join(' · ')
}

/**
 * Левая колонка выбора аккаунтов — как список чатов в мессенджере: строка с аватаром,
 * именем, второй строкой и статусом. Раньше здесь была стена одинаковых чипов
 * с сырыми id, где не видно ни имени, ни того, что аккаунт в спамблоке.
 */
export function AccountRail({
  accounts, selected, onOnly,
}: {
  accounts: TgAccount[]
  /** Одиночный выбор: множество осталось ради совместимости вызывающих экранов. */
  selected: Set<string>
  /** Клик по строке — показать ЭТОТ аккаунт (и только его). */
  onOnly: (id: string) => void
}) {
  const [q, setQ] = useState('')

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const rows = needle
      ? accounts.filter((a) => `${accountLabel(a)} ${a.username} ${a.phone} ${a.id}`.toLowerCase().includes(needle))
      : accounts
    // Проблемные — наверх: именно их ищут, когда открывают этот экран.
    const weight = (a: TgAccount) => (a.status === 'active' ? 2 : a.status === 'working' ? 1 : 0)
    return [...rows].sort((a, b) => weight(a) - weight(b) || accountLabel(a).localeCompare(accountLabel(b), 'ru'))
  }, [accounts, q])

  const counts = useMemo(() => {
    const by: Record<string, number> = {}
    for (const a of accounts) by[a.status] = (by[a.status] || 0) + 1
    return by
  }, [accounts])

  return (
    <div className="flex max-h-[70vh] flex-col overflow-hidden rounded-2xl border border-line bg-elevated/40">
      <div className="border-b border-line p-2.5">
        <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
          <Users size={13} /> Аккаунты
          <span className="ml-auto font-mono text-[11px] text-white/40">{accounts.length}</span>
        </div>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Имя, @username, телефон…"
            className="input h-8 pl-7 text-xs"
          />
        </div>
        {/* Сводка по статусам: сразу видно, сколько аккаунтов не в строю. */}
        <div className="mt-2 flex flex-wrap gap-1">
          {Object.entries(counts)
            .filter(([s]) => s !== 'active')
            .map(([s, n]) => (
              <span key={s} className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-white/50">
                {STATUS_META[s as TgAccount['status']]?.label || s}: {n}
              </span>
            ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 && <div className="p-4 text-center text-xs text-white/35">Ничего не найдено</div>}
        {list.map((a) => {
          const on = selected.has(a.id)
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              onClick={() => onOnly(a.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onOnly(a.id) }}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 border-b border-line/50 px-2.5 py-2 transition-colors last:border-0',
                // Выбор одиночный, поэтому выделение должно читаться с первого взгляда:
                // раньше это была почти незаметная подложка при живой галочке рядом.
                on ? 'bg-spark-500/15 shadow-[inset_3px_0_0_0_theme(colors.spark.500)]' : 'hover:bg-white/4',
              )}
              title="Показать этот аккаунт"
            >
              <Avatar name={accountLabel(a)} color={a.avatarColor} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-fg">{accountLabel(a)}</div>
                <div className="truncate text-[11px] text-white/40">{accountSub(a)}</div>
                {/* Статус показываем только когда он важен: у «активных» бейдж
                    занимал бы место в каждой строке и перестал бы читаться. */}
                {a.status !== 'active' && (
                  <div className="mt-0.5">
                    <StatusBadge status={a.status} until={a.statusUntil} reason={a.statusReason} />
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
