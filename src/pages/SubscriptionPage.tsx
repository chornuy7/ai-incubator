import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, Package, Sparkles, Loader2, Zap } from 'lucide-react'
import { PageHeader, Card } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { usePlan } from '@/features/billing/plan'
import { fetchSubscription, saveSubscription, type Subscription } from '@/api/balanceApi'
import { cn } from '@/shared/lib/utils'
import { WalletHistory } from '@/pages/ProfilePage'

/**
 * §5.4: кабинет подписки — клиент СОБИРАЕТ набор модулей сам.
 *
 * Заказчик (23.07): «людина хоче нейрочатінг + мейлінг — вибирає собі модулі які
 * хоче, сума сумується і оплачується в кабінеті, доступ тільки до них». Поэтому
 * здесь не выбор из трёх коробок, а конструктор: отметил — увидел сумму — оплатил.
 * Готовые сетапы рядом как быстрый путь, они же дают скидку за связку.
 *
 * §11.2 (уточнение 31.07): это ТОЛЬКО ВЫБОР — как на лендинге. Правка цен и сборка
 * наборов живут в АДМИН-панели (вкладки «Цены»/«Наборы»), а не в кабинете клиента:
 * кабинет не должен выглядеть как редактор. Сумму считает сервер
 * (`/api/subscription/quote`): витрина и то, что спишется, — одно число.
 */
export function SubscriptionPage() {
  const pushToast = useApp((s) => s.pushToast)
  const loadPlan = usePlan((s) => s.load)
  const [data, setData] = useState<Subscription | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [period, setPeriod] = useState<'month' | 'year'>('month')

  // Модуль, пришедший с лендинга (?apply=<key>) — предвыбираем его поверх текущего набора.
  const [params] = useSearchParams()
  const applyKey = params.get('apply') || ''
  useEffect(() => {
    void fetchSubscription().then((d) => {
      setData(d)
      const base = new Set(d.mine === 'all' ? d.items.map((i) => i.key) : d.mine)
      if (applyKey && d.items.some((i) => i.key === applyKey)) base.add(applyKey)
      setPicked(base)
    }).catch(() => {})
  }, [applyKey])

  const keys = useMemo(() => [...picked], [picked])

  // Считаем на клиенте ТОЛЬКО для мгновенной реакции на клик; при сохранении
  // сумму пересчитывает сервер, и она — окончательная.
  const cost = useMemo(() => {
    if (!data) return { sum: 0, full: 0, setup: null as string | null, discount: 0, giftTokens: 0, monthlyTokens: 0 }
    // §3 (MR-21): подарочные токены суммируются по выбранным модулям.
    const giftTokens = data.items.filter((i) => picked.has(i.key)).reduce((a, i) => a + (i.gift || 0), 0)
    // MR-150: месячная выдача токенов — сумма по выбранным модулям (напр. 14 × 100 = 1400/мес).
    const monthlyTokens = data.items.filter((i) => picked.has(i.key)).reduce((a, i) => a + (i.monthlyTokens || 0), 0)
    const full = data.items.filter((i) => picked.has(i.key)).reduce((a, i) => a + i.price, 0)
    let best = { setup: null as string | null, discount: 0, sum: full }
    for (const s of data.setups) {
      if (s.custom) {
        // Набор админа: цена явная и только на ТОЧНЫЙ состав — «20 $ за парсер +
        // комментинг» не скидочный коэффициент на любую корзину с ними.
        const exact = s.modules.length === picked.size && s.modules.every((m) => picked.has(m))
        const price = s.price ?? s.cost.sum
        if (exact && price > 0 && price < best.sum) {
          best = { setup: s.id, discount: full ? Math.round((1 - price / full) * 1000) / 1000 : 0, sum: price }
        }
      } else if (s.modules.every((m) => picked.has(m))) {
        // MR-150: цены округляем ВВЕРХ до целых (CEIL) — «дробные $ путают».
        const sum = Math.ceil(full * (1 - s.discount))
        if (sum < best.sum) best = { setup: s.id, discount: s.discount, sum }
      }
    }
    return { sum: Math.ceil(best.sum), full: Math.ceil(full), setup: best.setup, discount: best.discount, giftTokens, monthlyTokens }
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
      await saveSubscription(keys, period === 'year' ? 12 : 1)
      await loadPlan() // меню должно перестроиться сразу, а не после перезагрузки
      pushToast({ type: 'success', title: 'Подписка обновлена', desc: `Открыто модулей: ${keys.length} · на ${period === 'year' ? 'год' : 'месяц'}` })
      const fresh = await fetchSubscription()
      setData(fresh)
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось сохранить', desc: e instanceof Error ? e.message : '' })
    } finally { setSaving(false) }
  }

  if (!data) return <div className="p-8 text-center text-muted"><Loader2 className="mx-auto animate-spin" /></div>
  const cur = data.currency
  // Годовая скидка — с сервера (правится из админки), не из статичного catalog.
  const annualDiscount = data.annualDiscount ?? 0.2
  const mineSet = new Set(data.mine === 'all' ? data.items.map((i) => i.key) : data.mine)
  const changed = keys.length !== mineSet.size || keys.some((k) => !mineSet.has(k))

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Package size={20} />}
        title="Подписки"
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
                {s.custom && <span className="rounded-md bg-iris-500/15 px-1.5 py-0.5 text-[10px] font-bold text-iris-300">набор</span>}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted">{s.hint}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-display text-xl font-bold text-fg">{Math.ceil(s.cost.sum)} {cur}</span>
                {s.cost.sum < s.cost.full && <span className="text-xs text-muted line-through">{Math.ceil(s.cost.full)} {cur}</span>}
                {s.discount > 0 && (
                  <span className="rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">−{Math.round(s.discount * 100)}%</span>
                )}
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
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md border', on ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line')}>
                    {on && <Check size={13} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-fg">{m.title}</span>
                      {mineSet.has(m.key) && <span className="shrink-0 rounded-md bg-white/8 px-1.5 py-0.5 text-[10px] font-bold text-muted">оплачен</span>}
                    </span>
                    {/* §3.2 (MR-22): калькулятор — сколько действий даёт 100 ⚡ для этого модуля. */}
                    <span className="block text-[11px] text-muted">
                      {m.action && m.action > 0 ? `≈ ${Math.round(100 / m.action).toLocaleString('ru-RU')} действий за 100 ⚡` : 'действия бесплатны'}
                      {m.gift ? <span className="text-spark-300"> · +{m.gift} ⚡ в подарок</span> : null}
                    </span>
                  </span>
                </span>
                {/* §11.2 (31.07): в кабинете цена — только текстом. Правка цен — в админ-панели. */}
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
            {/* Год — со скидкой annualDiscount от 12 месяцев. Скидка приходит с
                сервера (правится в админке) — витрина, запись платежа и админский
                контрол теперь одно число, а не три. MR-150: цена CEIL до целых. */}
            <span className="font-display text-2xl font-bold text-fg">{period === 'year' ? Math.ceil(cost.sum * 12 * (1 - annualDiscount)) : cost.sum} {cur}</span>
            <span className="text-sm text-muted">{period === 'year' ? 'за год' : 'в месяц'}</span>
            {period === 'year' && <span className="rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">−{Math.round(annualDiscount * 100)}%</span>}
            {period === 'month' && cost.discount > 0 && <span className="text-sm text-muted line-through">{cost.full} {cur}</span>}
          </div>
          {/* MR-150: общее число токенов в месяц по подписке (сумма выдачи выбранных модулей),
              а подарок — ОТДЕЛЬНОЙ жёлтой строкой ниже, чтобы не смешивать месячную выдачу с бонусом. */}
          {cost.monthlyTokens > 0 && (
            <div className="mt-1 flex items-center gap-1 text-xs text-muted">
              <Zap size={12} /> {cost.monthlyTokens.toLocaleString('ru-RU')} ⚡ токенов в месяц
            </div>
          )}
          {cost.giftTokens > 0 && (
            <div className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-amber-300">
              <Zap size={12} fill="currentColor" /> +{cost.giftTokens.toLocaleString('ru-RU')} ⚡ токенов в подарок
            </div>
          )}
        </div>
        {/* Период подписки: на месяц или на год — определяет срок действия (expiresAt). */}
        <div className="flex rounded-xl border border-line bg-elevated p-0.5 text-sm">
          {(['month', 'year'] as const).map((p) => (
            <button key={p} onClick={() => setPeriod(p)} className={cn('h-9 rounded-lg px-3 font-semibold transition-colors', period === p ? 'bg-spark-500/15 text-spark-300' : 'text-muted hover:text-fg')}>
              {p === 'month' ? 'Месяц' : 'Год'}{p === 'year' && <span className="ml-1 text-[10px] text-spark-400">−{Math.round(annualDiscount * 100)}%</span>}
            </button>
          ))}
        </div>
        <button
          onClick={() => void save()}
          disabled={saving || !changed}
          className="btn-primary ml-auto h-11 min-w-[190px] disabled:opacity-40"
          title={changed ? 'Спишется с баланса $ за добавленные модули' : 'Набор не менялся'}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {keys.length === 0 ? 'Отключить все модули' : `Оплатить на ${period === 'year' ? 'год' : 'месяц'}`}
        </button>
      </div>

      <p className="text-xs text-muted">
        Списывается с баланса $ и только за <b className="text-fg">добавленные</b> модули — смена набора
        или отключение лишнего повторно не стоят ничего. Модули, которых нет в подписке, не показываются
        в меню и не запускаются. Права ролей действуют отдельно: сотрудник видит только то, что и оплачено,
        и разрешено ему администратором.
      </p>

      {/* MR-158: «История операций» перенесена сюда из профиля — это раздел про деньги/подписку. */}
      <WalletHistory />
    </div>
  )
}
