import { useEffect, useState } from 'react'
import { Trash2, Loader2, Plus, Check } from 'lucide-react'
import { Card } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { useApp } from '@/mocks/store'
import { fetchSetups, saveSetup, deleteSetup, type AdminSetup } from '@/api/setupsApi'
import type { PriceModule } from '@/api/adminApi'

/**
 * MR-149 (созвон 19.08): редактор готовых сетапов (скидочных наборов) — из админки.
 * Раньше три сетапа со скидками 20%/35% были захардкожены в server/pricing.js; заказчик:
 * «экономики в коде быть не должно». Сетап = скидка (доля от прайса) на ТОЧНЫЙ набор
 * модулей; «Всё включено» — состав = все модули (allModules), включает новые сам.
 *
 * Отличие от «Готовых наборов» (BundlesEditor): там ЯВНАЯ цена, тут СКИДКА — набор
 * пересчитывается при изменении цен модулей.
 */
export function SetupsEditor({ modules }: { modules: PriceModule[] }) {
  const pushToast = useApp((s) => s.pushToast)
  const [setups, setSetups] = useState<AdminSetup[]>([])
  const [dirty, setDirty] = useState<Record<string, number>>({}) // id → скидка % (правка существующего)
  const [busy, setBusy] = useState('')
  // Конструктор нового сетапа
  const [name, setName] = useState('')
  const [hint, setHint] = useState('')
  const [disc, setDisc] = useState('')
  const [allMods, setAllMods] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)

  const load = async () => {
    try { setSetups(await fetchSetups()); setDirty({}) }
    catch (e) { pushToast({ type: 'error', title: 'Не удалось загрузить сетапы', desc: e instanceof Error ? e.message : '' }) }
  }
  useEffect(() => { void load() }, [])

  const pct = (frac: number) => Math.round(frac * 100)
  const cleanPct = (v: string) => v.replace(/[^\d]/g, '').slice(0, 2)

  const saveDiscount = async (s: AdminSetup) => {
    const next = dirty[s.id]
    if (next == null || next === pct(s.discount)) return
    setBusy(s.id)
    try {
      await saveSetup({ id: s.id, name: s.name, hint: s.hint, discount: next / 100, allModules: s.allModules, modules: s.modules })
      pushToast({ type: 'success', title: 'Скидка сохранена', desc: `${s.name}: ${next}%` })
      await load()
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось сохранить', desc: e instanceof Error ? e.message : '' }) }
    finally { setBusy('') }
  }

  const remove = async (s: AdminSetup) => {
    setBusy(s.id)
    try { await deleteSetup(s.id); pushToast({ type: 'success', title: 'Сетап удалён', desc: s.name }); await load() }
    catch (e) { pushToast({ type: 'error', title: 'Не удалось удалить', desc: e instanceof Error ? e.message : '' }) }
    finally { setBusy('') }
  }

  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n })

  const create = async () => {
    const d = Number(disc)
    if (!name.trim()) { pushToast({ type: 'error', title: 'Укажите название сетапа' }); return }
    if (!allMods && picked.size < 2) { pushToast({ type: 'error', title: 'Выберите минимум два модуля' }); return }
    if (!Number.isFinite(d) || d < 0 || d > 90) { pushToast({ type: 'error', title: 'Скидка — от 0 до 90%' }); return }
    setCreating(true)
    try {
      await saveSetup({ name: name.trim(), hint: hint.trim(), discount: d / 100, allModules: allMods, modules: [...picked] })
      pushToast({ type: 'success', title: 'Сетап создан', desc: 'Уже на витрине подписки' })
      setName(''); setHint(''); setDisc(''); setAllMods(false); setPicked(new Set())
      await load()
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось создать', desc: e instanceof Error ? e.message : '' }) }
    finally { setCreating(false) }
  }

  return (
    <Card className="p-4">
      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Сетапы (скидочные наборы)</div>
      <p className="mb-3 text-[11px] text-faint">Скидка — доля от суммы входящих модулей. Действует, когда клиент выбрал ровно этот состав.</p>

      {/* Существующие сетапы */}
      {setups.length ? (
        <div className="mb-4 space-y-2">
          {setups.map((s) => {
            const cur = dirty[s.id] ?? pct(s.discount)
            const changed = cur !== pct(s.discount)
            return (
              <div key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line/40 pb-2 text-sm last:border-0">
                <span className="font-medium text-fg">{s.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-faint">
                  {s.allModules ? 'Все модули' : s.modules.map((k) => modules.find((m) => m.key === k)?.title || k).join(', ')}
                </span>
                <div className="flex items-center gap-1">
                  <input
                    value={String(cur)}
                    onChange={(e) => setDirty((d) => ({ ...d, [s.id]: Number(cleanPct(e.target.value)) }))}
                    inputMode="numeric"
                    className="input h-8 w-14 text-center text-sm tabular-nums"
                    aria-label={`Скидка ${s.name}`}
                  />
                  <span className="text-xs text-muted">%</span>
                </div>
                <button onClick={() => void saveDiscount(s)} disabled={!changed || busy === s.id}
                  className="shrink-0 rounded-md border border-spark-500/40 px-2 py-1 text-xs text-spark-200 hover:bg-spark-500/10 disabled:opacity-30">
                  {busy === s.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                </button>
                <button onClick={() => void remove(s)} disabled={busy === s.id}
                  className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-red-500/40 hover:text-red-300 disabled:opacity-40">
                  <Trash2 size={12} />
                </button>
              </div>
            )
          })}
        </div>
      ) : <p className="mb-4 text-xs text-muted">Сетапов пока нет (или БД без таблицы setups — применяются код-дефолты).</p>}

      {/* Конструктор нового сетапа */}
      <div className="rounded-xl border border-line bg-elevated/40 p-3">
        <div className="mb-2 flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название сетапа" className="input h-9 flex-1 text-sm" />
          <input value={disc} onChange={(e) => setDisc(cleanPct(e.target.value))} inputMode="numeric" placeholder="Скидка %" className="input h-9 w-24 text-sm tabular-nums" />
        </div>
        <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Описание (для чего набор)" className="input mb-2 h-9 w-full text-sm" />
        <label className="mb-2 flex cursor-pointer items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={allMods} onChange={(e) => setAllMods(e.target.checked)} />
          «Всё включено» — состав = все модули (автоматически включает новые)
        </label>
        {!allMods && (
          <div className="flex flex-wrap gap-1.5">
            {modules.map((m) => {
              const on = picked.has(m.key)
              return (
                <button key={m.key} onClick={() => toggle(m.key)}
                  className={cn('rounded-lg border px-2 py-1 text-xs transition-colors', on ? 'border-spark-500/50 bg-spark-500/10 text-spark-200' : 'border-line text-muted hover:border-spark-500/25')}>
                  {on ? '✓ ' : ''}{m.title}
                </button>
              )
            })}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] text-muted">{allMods ? 'Все модули' : `Выбрано: ${picked.size}`}</span>
          <button onClick={() => void create()} disabled={creating} className="btn-primary ml-auto h-8 text-xs disabled:opacity-40">
            {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Создать сетап
          </button>
        </div>
      </div>
    </Card>
  )
}
