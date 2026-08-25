import { useEffect, useState } from 'react'
import { Trash2, Loader2, Plus } from 'lucide-react'
import { Card } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { useApp } from '@/mocks/store'
import { fetchBundles, createBundle, deleteBundle, type SubSetup } from '@/api/balanceApi'
import type { PriceModule } from '@/api/adminApi'
import { cleanPrice } from './adminShared'

/**
 * §10.4/§10.6: редактор готовых наборов (шаблонов модулей, что продаём) — из админки.
 * Раньше жил только в кабинете подписки; по звонку всё, что продаём, должно собираться
 * и управляться из админки. Набор = имя + явная цена + состав модулей; на витрине лендинга
 * это «готовые наборы».
 */
export function BundlesEditor({ modules, currency }: { modules: PriceModule[]; currency: string }) {
  const pushToast = useApp((s) => s.pushToast)
  const [bundles, setBundles] = useState<SubSetup[]>([])
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      // Свои наборы отдельным запросом: раньше тянули всю витрину ради этого списка,
      // и вкладка «Цены» грузила /api/subscription (MR-151, созвон 19.08).
      setBundles(await fetchBundles())
    } catch { /* витрина недоступна — просто пусто */ }
  }
  useEffect(() => { void load() }, [])

  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n })

  const create = async () => {
    const p = Number(price)
    if (!name.trim()) { pushToast({ type: 'error', title: 'Укажите название набора' }); return }
    if (!picked.size) { pushToast({ type: 'error', title: 'Выберите хотя бы один модуль' }); return }
    if (!Number.isFinite(p) || p <= 0) { pushToast({ type: 'error', title: 'Укажите цену набора' }); return }
    setBusy(true)
    try {
      await createBundle({ name: name.trim(), modules: [...picked], price: p })
      pushToast({ type: 'success', title: 'Набор создан', desc: 'Уже на витрине лендинга и в кабинете' })
      setName(''); setPrice(''); setPicked(new Set())
      await load()
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось создать', desc: e instanceof Error ? e.message : '' }) }
    finally { setBusy(false) }
  }

  const remove = async (id: string, nm: string) => {
    setBusy(true)
    try { await deleteBundle(id); pushToast({ type: 'success', title: 'Набор удалён', desc: nm }); await load() }
    catch (e) { pushToast({ type: 'error', title: 'Не удалось удалить', desc: e instanceof Error ? e.message : '' }) }
    finally { setBusy(false) }
  }

  return (
    <Card className="p-4">
      <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">Готовые наборы (что продаём)</div>

      {/* Существующие наборы */}
      {bundles.length ? (
        <div className="mb-4 space-y-1.5">
          {bundles.map((b) => (
            <div key={b.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line/40 pb-1.5 text-sm last:border-0">
              <span className="font-medium text-fg">{b.name}</span>
              <span className="font-semibold tabular-nums text-spark-300">{currency}{b.price ?? b.cost.sum}</span>
              <span className="text-xs text-muted">· {b.modules.length} мод.</span>
              {/* MR-188: сколько те же модули стоили бы по отдельности и сколько человек
                  экономит. Одна цена набора не отвечает на вопрос «а выгодно ли». */}
              {(() => {
                const apart = b.modules.reduce((sum, k) => sum + Number(modules.find((m) => m.key === k)?.month || 0), 0)
                const pay = Number(b.price ?? b.cost.sum) || 0
                if (!apart || !pay || apart <= pay) return null
                return (
                  <span className="text-xs tabular-nums text-faint">
                    по отдельности {currency}{apart} · экономия <span className="text-emerald-300/80">{currency}{(apart - pay).toFixed(0)}</span>
                  </span>
                )
              })()}
              <span className="min-w-0 flex-1 truncate text-xs text-faint">{b.modules.map((k) => modules.find((m) => m.key === k)?.title || k).join(', ')}</span>
              <button onClick={() => void remove(b.id, b.name)} disabled={busy}
                className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-muted hover:border-red-500/40 hover:text-red-300 disabled:opacity-40">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : <p className="mb-4 text-xs text-muted">Наборов пока нет — соберите первый ниже.</p>}

      {/* Конструктор нового набора */}
      <div className="rounded-xl border border-line bg-elevated/40 p-3">
        <div className="mb-2 flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название набора" className="input h-9 flex-1 text-sm" />
          <input value={price} onChange={(e) => setPrice(cleanPrice(e.target.value, 100000))} inputMode="decimal" placeholder="Цена $/мес" className="input h-9 w-32 text-sm tabular-nums" />
        </div>
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
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] text-muted">Выбрано: {picked.size}</span>
          <button onClick={() => void create()} disabled={busy} className="btn-primary ml-auto h-8 text-xs disabled:opacity-40">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Создать набор
          </button>
        </div>
      </div>
    </Card>
  )
}
