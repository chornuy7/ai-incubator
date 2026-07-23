import { useEffect, useMemo, useState } from 'react'
import { Check, Package, Sparkles, Loader2 } from 'lucide-react'
import { PageHeader, Card } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { usePlan } from '@/features/billing/plan'
import { fetchSubscription, saveSubscription, type Subscription } from '@/api/balanceApi'
import { cn } from '@/shared/lib/utils'

/**
 * §5.4: кабинет подписки — клиент СОБИРАЕТ набор модулей сам.
 *
 * Заказчик (23.07): «людина хоче нейрочатінг + мейлінг — вибирає собі модулі які
 * хоче, сума сумується і оплачується в кабінеті, доступ тільки до них». Поэтому
 * здесь не выбор из трёх коробок, а конструктор: отметил — увидел сумму — оплатил.
 * Готовые сетапы рядом как быстрый путь, они же дают скидку за связку.
 *
 * Сумму считает сервер (`/api/subscription/quote`): витрина и то, что спишется,
 * обязаны быть одним числом, а не двумя реализациями одной формулы.
 */
export function SubscriptionPage() {
  const pushToast = useApp((s) => s.pushToast)
  const loadPlan = usePlan((s) => s.load)
  const [data, setData] = useState<Subscription | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void fetchSubscription().then((d) => {
      setData(d)
      setPicked(new Set(d.mine === 'all' ? d.items.map((i) => i.key) : d.mine))
    }).catch(() => {})
  }, [])

  const keys = useMemo(() => [...picked], [picked])

  // Считаем на клиенте ТОЛЬКО для мгновенной реакции на клик; при сохранении
  // сумму пересчитывает сервер, и она — окончательная.
  const cost = useMemo(() => {
    if (!data) return { sum: 0, full: 0, setup: null as string | null, discount: 0 }
    const full = data.items.filter((i) => picked.has(i.key)).reduce((a, i) => a + i.price, 0)
    let best = { setup: null as string | null, discount: 0 }
    for (const s of data.setups) {
      if (s.modules.every((m) => picked.has(m)) && s.discount > best.discount) best = { setup: s.id, discount: s.discount }
    }
    return { sum: Math.round(full * (1 - best.discount) * 100) / 100, full, ...best }
  }, [data, picked])

  const toggle = (key: string) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const applySetup = (modules: string[]) => setPicked(new Set(modules))

  const save = async () => {
    setSaving(true)
    try {
      await saveSubscription(keys)
      await loadPlan() // меню должно перестроиться сразу, а не после перезагрузки
      pushToast({ type: 'success', title: 'Подписка обновлена', desc: `Открыто модулей: ${keys.length}` })
      const fresh = await fetchSubscription()
      setData(fresh)
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось сохранить', desc: e instanceof Error ? e.message : '' })
    } finally { setSaving(false) }
  }

  if (!data) return <div className="p-8 text-center text-muted"><Loader2 className="mx-auto animate-spin" /></div>
  const cur = data.currency
  const mineSet = new Set(data.mine === 'all' ? data.items.map((i) => i.key) : data.mine)
  const changed = keys.length !== mineSet.size || keys.some((k) => !mineSet.has(k))

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Package size={20} />}
        title="Мои модули"
        subtitle="Выберите модули, которыми пользуетесь. Платите только за них — сумма пересчитывается сразу."
      />

      <Card>
        <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">Готовые наборы</div>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {data.setups.map((s) => (
            <button
              key={s.id}
              onClick={() => applySetup(s.modules)}
              className={cn(
                'rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5',
                cost.setup === s.id ? 'border-spark-500/50 bg-spark-500/8' : 'border-line bg-elevated',
              )}
            >
              <div className="flex items-center gap-1.5 font-display text-base font-bold text-fg">
                <Sparkles size={15} className="text-spark-400" /> {s.name}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted">{s.hint}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-display text-xl font-bold text-fg">{s.cost.sum} {cur}</span>
                <span className="text-xs text-muted line-through">{s.cost.full} {cur}</span>
                <span className="rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">−{Math.round(s.discount * 100)}%</span>
              </div>
              <div className="mt-1 text-[11px] text-muted">{s.modules.length} модулей</div>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">Модули поштучно · в месяц</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {data.items.map((m) => {
            const on = picked.has(m.key)
            return (
              <button
                key={m.key}
                onClick={() => toggle(m.key)}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                  on ? 'border-spark-500/45 bg-spark-500/8' : 'border-line bg-elevated hover:border-spark-500/25',
                )}
              >
                <span className="flex items-center gap-2.5">
                  <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md border', on ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line')}>
                    {on && <Check size={13} strokeWidth={3} />}
                  </span>
                  <span className="text-sm font-medium text-fg">{m.title}</span>
                  {mineSet.has(m.key) && <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[10px] font-bold text-muted">оплачен</span>}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-fg">{m.price} {cur}</span>
              </button>
            )
          })}
        </div>
      </Card>

      {/* Итог держим на виду: сумма меняется от каждого клика, и уезжать за ней вниз незачем. */}
      <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 backdrop-blur-xl">
        <div className="min-w-0">
          <div className="text-xs text-muted">
            Выбрано модулей: <b className="text-fg">{keys.length}</b>
            {cost.setup && <> · набор «{data.setups.find((s) => s.id === cost.setup)?.name}» — скидка {Math.round(cost.discount * 100)}%</>}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold text-fg">{cost.sum} {cur}</span>
            <span className="text-sm text-muted">в месяц</span>
            {cost.discount > 0 && <span className="text-sm text-muted line-through">{cost.full} {cur}</span>}
          </div>
        </div>
        <button
          onClick={() => void save()}
          disabled={saving || !changed}
          className="btn-primary ml-auto h-11 min-w-[190px] disabled:opacity-40"
          title={changed ? 'Оплата в демо отключена — набор применится сразу' : 'Набор не менялся'}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {keys.length === 0 ? 'Отключить все модули' : 'Оплатить и открыть'}
        </button>
      </div>

      <p className="text-xs text-muted">
        Оплата в демо отключена — выбранный набор применяется сразу. Модули, которых нет в подписке,
        не показываются в меню и не запускаются. Права ролей действуют отдельно: сотрудник видит только
        то, что и оплачено, и разрешено ему администратором.
      </p>
    </div>
  )
}
