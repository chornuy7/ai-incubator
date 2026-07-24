import { useEffect, useMemo, useState } from 'react'
import { Check, Package, Sparkles, Loader2, Trash2, Plus } from 'lucide-react'
import { PageHeader, Card } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { usePlan } from '@/features/billing/plan'
import { useSession } from '@/features/auth/session'
import { fetchSubscription, saveSubscription, createBundle, deleteBundle, type Subscription } from '@/api/balanceApi'
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
  // Конструктор наборов и их удаление — владельцу; клиент видит витрину и покупает.
  const sessionUser = useSession((st) => st.user)
  const isAdmin = !sessionUser || !!sessionUser.isAdmin
  const [data, setData] = useState<Subscription | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  // Форма «собрать набор под клиента»: имя + цена, состав берётся из текущего выбора.
  const [bundleName, setBundleName] = useState('')
  const [bundlePrice, setBundlePrice] = useState('')
  const [bundleBusy, setBundleBusy] = useState(false)

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
        const sum = Math.round(full * (1 - s.discount) * 100) / 100
        if (sum < best.sum) best = { setup: s.id, discount: s.discount, sum }
      }
    }
    return { sum: best.sum, full, setup: best.setup, discount: best.discount }
  }, [data, picked])

  const toggle = (key: string) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const applySetup = (modules: string[]) => setPicked(new Set(modules))

  const reload = async () => {
    const fresh = await fetchSubscription()
    setData(fresh)
  }

  /**
   * Сохранить текущий выбор как именованный набор с ЯВНОЙ ценой. Это то, как
   * реально продают: «клиенту нужен парсер + комментинг за 20 $» — админ собирает
   * ровно этот пакет, и покупатель получает ровно эти модули.
   */
  const saveBundle = async () => {
    const price = Number(String(bundlePrice).replace(',', '.'))
    if (!bundleName.trim()) { pushToast({ type: 'error', title: 'Дайте набору имя', desc: 'Его увидит клиент' }); return }
    if (!Number.isFinite(price) || price <= 0) { pushToast({ type: 'error', title: 'Нужна цена больше нуля', desc: 'Например 20' }); return }
    if (!keys.length) { pushToast({ type: 'error', title: 'Отметьте модули', desc: 'Набор собирается из текущего выбора' }); return }
    setBundleBusy(true)
    try {
      await createBundle({ name: bundleName.trim(), modules: keys, price })
      pushToast({ type: 'success', title: `Набор «${bundleName.trim()}» создан`, desc: `${keys.length} модулей за ${price} ${data?.currency ?? '$'}` })
      setBundleName(''); setBundlePrice('')
      await reload()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось создать набор', desc: e instanceof Error ? e.message : '' })
    } finally { setBundleBusy(false) }
  }

  const removeBundle = async (id: string, name: string) => {
    try {
      await deleteBundle(id)
      pushToast({ type: 'success', title: `Набор «${name}» удалён`, desc: 'Уже купленные подписки не тронуты' })
      await reload()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось удалить', desc: e instanceof Error ? e.message : '' })
    }
  }

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
                {s.custom && <span className="rounded-md bg-iris-500/15 px-1.5 py-0.5 text-[10px] font-bold text-iris-300">ваш набор</span>}
                {s.custom && isAdmin && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); void removeBundle(s.id, s.name) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void removeBundle(s.id, s.name) } }}
                    className="ml-auto grid h-6 w-6 place-items-center rounded-md border border-line text-muted transition-colors hover:border-red-500/40 hover:text-red-300"
                    title="Удалить набор (купленные подписки не тронет)"
                  >
                    <Trash2 size={12} />
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted">{s.hint}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-display text-xl font-bold text-fg">{s.cost.sum} {cur}</span>
                {s.cost.sum < s.cost.full && <span className="text-xs text-muted line-through">{s.cost.full} {cur}</span>}
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

      {/* Собрать набор под клиента: состав = текущий выбор, цена — явная.
          Продают именно так: «парсер + комментинг за 20 $», а не «минус N % от прайса». */}
      {isAdmin && (
      <Card>
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Собрать набор для клиента</div>
        <p className="mb-3 text-xs text-muted">
          Отметьте модули выше, назовите набор и цену — он появится в «Готовых наборах» и на лендинге.
          Покупатель получит ровно эти модули; монеты за действия и токены ИИ — сверх, как обычно.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={bundleName}
            onChange={(e) => setBundleName(e.target.value)}
            className="input h-10 min-w-0 flex-1 sm:max-w-xs"
            placeholder="Название — например «Парсер + Комментинг»"
          />
          <input
            value={bundlePrice}
            onChange={(e) => setBundlePrice(e.target.value)}
            className="input h-10 w-28 text-right tabular-nums"
            placeholder="20"
            inputMode="decimal"
          />
          <span className="text-sm text-muted">{cur} / мес</span>
          <button
            onClick={() => void saveBundle()}
            disabled={bundleBusy}
            className="btn-ghost h-10 border border-line disabled:opacity-40"
          >
            {bundleBusy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Создать набор из выбранного ({keys.length})
          </button>
        </div>
      </Card>
      )}

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
