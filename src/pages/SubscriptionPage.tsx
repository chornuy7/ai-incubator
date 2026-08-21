import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, Package, Sparkles, Loader2, Lock, CalendarClock, AlertTriangle, ExternalLink } from 'lucide-react'
import { PageHeader, Card } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { usePlan } from '@/features/billing/plan'
import { useBalance } from '@/features/billing/balanceStore'
import { expiryInfo, daysLeftPhrase } from '@/features/billing/expiry'
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
  // §5 (21.08): «оплачено до …». Срок лежит в балансе (`expiresAt`) — /api/subscription
  // отдаёт только СОСТАВ набора (`mine`), а без даты кабинет молчал о том, сколько
  // подписка ещё живёт, и человек узнавал об окончании по отказу задачи.
  const balance = useBalance()
  const exp = expiryInfo(balance?.expiresAt)
  // Пока баланс не приехал, срок НЕИЗВЕСТЕН — а `expiryInfo(undefined)` честно
  // отвечает «бессрочно». Показать это до ответа значит мигнуть человеку «платить
  // больше не надо», поэтому подписи со сроком ждут ответа.
  const expKnown = !!balance

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

  /**
   * Что УЖЕ оплачено. Снять это в кабинете нельзя (баг 19.08 §2): сервер списывает
   * только за ДОБАВЛЕННОЕ (`addedCost`), поэтому снятый и заново отмеченный модуль
   * «оплачивался» бесплатно, а снятый и сохранённый — пропадал без возврата денег.
   */
  const mineSet = useMemo(
    () => new Set(!data ? [] : data.mine === 'all' ? data.items.map((i) => i.key) : data.mine),
    [data],
  )

  // Считаем на клиенте ТОЛЬКО для мгновенной реакции на клик; при сохранении
  // сумму пересчитывает сервер, и она — окончательная.
  const priceOf = useMemo(() => (sel: Set<string>) => {
    if (!data) return { sum: 0, full: 0, setup: null as string | null, discount: 0, giftTokens: 0, monthlyTokens: 0 }
    // §3 (MR-21): подарочные токены суммируются по выбранным модулям.
    const giftTokens = data.items.filter((i) => sel.has(i.key)).reduce((a, i) => a + (i.gift || 0), 0)
    // MR-150: месячная выдача токенов - сумма по выбранным модулям.
    const monthlyTokens = data.items.filter((i) => sel.has(i.key)).reduce((a, i) => a + (i.monthlyTokens || 0), 0)
    const full = data.items.filter((i) => sel.has(i.key)).reduce((a, i) => a + i.price, 0)
    let best = { setup: null as string | null, discount: 0, sum: full }
    for (const s of data.setups) {
      if (s.custom) {
        // Набор админа: цена явная и только на ТОЧНЫЙ состав — «20 $ за парсер +
        // комментинг» не скидочный коэффициент на любую корзину с ними.
        const exact = s.modules.length === sel.size && s.modules.every((m) => sel.has(m))
        const price = s.price ?? s.cost.sum
        if (exact && price > 0 && price < best.sum) {
          best = { setup: s.id, discount: full ? Math.round((1 - price / full) * 1000) / 1000 : 0, sum: price }
        }
      } else if (s.modules.length > 0 && s.modules.every((m) => sel.has(m))) {
        // MR-150: цены округляем ВВЕРХ до целых (CEIL) — «дробные $ путают».
        const sum = Math.round(full * (1 - s.discount))
        if (sum < best.sum) best = { setup: s.id, discount: s.discount, sum }
      }
    }
    // Округление — как на сервере (созвон 12.08: 120.25 → 120, 60.8 → 61), иначе
    // витрина обещает не ту цену, которую спишет сервер.
    return { sum: Math.round(best.sum), full: Math.round(full), setup: best.setup, discount: best.discount, giftTokens, monthlyTokens }
  }, [data])

  const cost = useMemo(() => priceOf(picked), [priceOf, picked])
  /** Что реально спишется: сервер заряжает только ДОБАВЛЕННЫЕ модули (`addedCost`). */
  const added = useMemo(() => keys.filter((k) => !mineSet.has(k)), [keys, mineSet])
  const due = useMemo(() => priceOf(new Set(added)), [priceOf, added])

  const toggle = (key: string) => {
    if (mineSet.has(key)) return // оплаченный модуль зафиксирован до конца периода
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }
  // Готовый набор ДОБАВЛЯЕТ к оплаченному, а не заменяет его: раньше он выкидывал
  // модули, за которые уже заплатили, и сохранение стирало их из подписки.
  const applySetup = (modules: string[]) => setPicked(new Set([...mineSet, ...modules]))

  const save = async () => {
    setSaving(true)
    try {
      await saveSubscription(keys, period === 'year' ? 12 : 1)
      // Меню должно перестроиться сразу, а не после перезагрузки. Заодно приезжает
      // новый срок: plan.load перечитывает общий баланс, а «оплачено до …» — из него.
      await loadPlan()
      // «Подписка обновлена» — про нашу внутреннюю сущность, а человек только что
      // КУПИЛ модули: говорим о том, что он сделал, а не о том, что мы записали.
      const n = added.length
      pushToast({
        type: 'success',
        title: n ? (n === 1 ? 'Модуль добавлен в подписку' : 'Модули добавлены в подписку') : 'Подписка продлена',
        desc: `${n ? `Добавлено: ${n} · в` : 'В'}сего в подписке: ${keys.length} · на ${period === 'year' ? 'год' : 'месяц'}`,
      })
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
  // Оплаченное снять нельзя, поэтому «изменилось» = что-то ДОБАВИЛИ.
  const changed = added.length > 0

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Package size={20} />}
        title="Подписки"
        subtitle="Выберите модули, которыми пользуетесь. Платите только за них — сумма пересчитывается сразу."
      />

      {/* §5 (21.08): срок подписки на виду. Раньше кабинет показывал только состав
          набора, и «до какого числа оплачено» человек не мог узнать нигде, кроме
          профиля. Три состояния: истекла (красное), кончается на неделе (жёлтое,
          с призывом продлить), обычное. Бессрочная так и подписана словом — пустая
          строка читалась бы как «данных нет». */}
      {expKnown && mineSet.size > 0 && (
        <Card className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-1 p-4',
          exp.expired ? 'border-red-500/40' : exp.soon ? 'border-amber-500/40' : '',
        )}>
          {exp.expired || exp.soon
            ? <AlertTriangle size={16} className={exp.expired ? 'text-red-300' : 'text-amber-300'} />
            : <CalendarClock size={16} className="text-muted" />}
          <span className={cn(
            'font-semibold',
            exp.expired ? 'text-red-300' : exp.soon ? 'text-amber-300' : 'text-fg',
          )}>
            {exp.perpetual
              ? 'Подписка бессрочная'
              : exp.expired
                ? `Подписка истекла ${exp.date}`
                : `Оплачено до ${exp.date}`}
          </span>
          <span className="text-sm text-muted">
            {exp.perpetual
              ? '· срок не ограничен — продлевать не нужно'
              : exp.expired
                ? '· модули не запускаются, пока подписку не продлят'
                : `· осталось ${daysLeftPhrase(exp.daysLeft)}${exp.soon ? ' — продлите, чтобы модули не остановились' : ''}`}
          </span>
        </Card>
      )}

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
                <span className="font-display text-xl font-bold text-fg">{Math.round(s.cost.sum)} {cur}</span>
                {s.cost.sum < s.cost.full && <span className="text-xs text-muted line-through">{Math.round(s.cost.full)} {cur}</span>}
                {s.discount > 0 && (
                  <span className="rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">−{Math.round(s.discount * 100)}%</span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-muted">{s.modules.length} модулей</div>
              {/* Что набор даёт в токенах: сумма месячной выдачи его модулей и подарок.
                  Заказчик просил видеть это рядом с ценой, а не только в итоге внизу. */}
              {(() => {
                const tok = data.items.filter((i) => s.modules.includes(i.key))
                const mo = tok.reduce((a, i) => a + (i.monthlyTokens || 0), 0)
                const gift = tok.reduce((a, i) => a + (i.gift || 0), 0)
                if (!mo && !gift) return null
                return (
                  <div className="mt-0.5 text-[11px]">
                    {mo ? <span className="text-fg/70">{mo.toLocaleString('ru-RU')} ⚡ в месяц</span> : null}
                    {mo && gift ? <span className="text-faint"> · </span> : null}
                    {gift ? <span className="text-amber-300">+{gift.toLocaleString('ru-RU')} ⚡ в подарок</span> : null}
                  </div>
                )
              })()}
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">Модули поштучно · в месяц</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {data.items.map((m) => {
            const on = picked.has(m.key)
            const paid = mineSet.has(m.key)
            return (
              <div
                key={m.key}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                  on ? 'border-spark-500/45 bg-spark-500/8' : 'border-line bg-elevated hover:border-spark-500/25',
                  paid && 'opacity-80',
                )}
              >
              <button
                type="button"
                onClick={() => toggle(m.key)}
                disabled={paid}
                title={paid
                  ? `Модуль оплачен${!expKnown ? '' : exp.perpetual ? ' бессрочно' : exp.expired ? ` до ${exp.date} — оплата закончилась` : ` до ${exp.date}`} — снять его в кабинете нельзя`
                  : undefined}
                className={cn('flex min-w-0 flex-1 items-center justify-between gap-3 text-left', paid && 'cursor-default')}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md border', on ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line')}>
                    {paid ? <Lock size={12} strokeWidth={3} /> : on && <Check size={13} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-fg">{m.title}</span>
                      {paid && <span className="shrink-0 rounded-md bg-white/8 px-1.5 py-0.5 text-[10px] font-bold text-muted">оплачен</span>}
                    </span>
                    {/* §3.2 (MR-22): калькулятор — сколько действий даёт 100 ⚡ для этого модуля. */}
                    <span className="block text-[11px] text-muted">
                      {/* §5 (21.08): у оплаченной плитки была общая фраза «до конца
                          оплаченного периода» — конца никто не знал. Пишем дату. */}
                      {paid
                        ? !expKnown
                          ? 'Уже в подписке'
                          : exp.perpetual
                            ? 'Уже в подписке — бессрочно'
                            : exp.expired ? `Оплата закончилась ${exp.date} — продлите` : `Оплачен до ${exp.date}`
                        : m.action && m.action > 0 ? `≈ ${Math.round(100 / m.action).toLocaleString('ru-RU')} действий за 100 ⚡` : 'действия бесплатны'}
                    </span>
                    {/* Сколько ⚡ даёт САМ модуль: месячная выдача и разовый подарок.
                        Показываем и у оплаченных: у кого всё куплено, иначе не видно
                        вообще ничего — а это ровно то, что человек получает за деньги. */}
                    {(m.monthlyTokens || m.gift) ? (
                      <span className="block text-[11px]">
                        {m.monthlyTokens ? <span className="text-fg/70">{m.monthlyTokens} ⚡ в месяц</span> : null}
                        {m.monthlyTokens && m.gift ? <span className="text-faint"> · </span> : null}
                        {m.gift ? <span className="text-amber-300">+{m.gift} ⚡ в подарок</span> : null}
                      </span>
                    ) : null}
                  </span>
                </span>
                {/* §11.2 (31.07): в кабинете цена — только текстом. Правка цен — в админ-панели. */}
                <span className="shrink-0 font-semibold tabular-nums text-fg">{m.price} {cur}</span>
              </button>
                {/*
                  «Подробнее о модуле» — на страницу модуля лендинга, в НОВОЙ вкладке
                  (просьба владельца 21.08). Человек читает описание, не потеряв набранную
                  корзину: возврат по крестику вкладки, а не «назад» с перезагрузкой выбора.
                  Отдельные парсеры своей страницы не имеют — у них одна общая, «Парсинг».
                  Ссылка вынесена ИЗ кнопки выбора: ссылка внутри кнопки — невалидная
                  разметка, и клик по ней заодно переключал бы галочку.
                */}
                <a
                  href={`/module/${m.key.startsWith('parsing') ? 'parsing' : m.key}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Подробнее о модуле — откроется в новой вкладке"
                  className="ml-1 flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-spark-500/40 hover:text-spark-300"
                >
                  Подробнее <ExternalLink size={11} className="shrink-0" />
                </a>
              </div>
            )
          })}
        </div>
      </Card>

      {/* Итог держим на виду: сумма меняется от каждого клика, и уезжать за ней вниз незачем. */}
      <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 backdrop-blur-xl">
        <div className="min-w-0">
          <div className="text-xs text-muted">
            В подписке модулей: <b className="text-fg">{keys.length}</b>
            {added.length > 0 && <> · добавлено <b className="text-fg">{added.length}</b></>}
            {due.setup && <> · набор «{data.setups.find((s) => s.id === due.setup)?.name}» — скидка {Math.round(due.discount * 100)}%</>}
          </div>
          <div className="flex items-baseline gap-2">
            {/* Показываем СУММУ К ОПЛАТЕ, а не цену всего набора: сервер списывает
                только за добавленные модули, и цена всего набора обещала бы списание,
                которого не будет. Год — со скидкой annualDiscount от 12 месяцев;
                скидка приходит с сервера (правится в админке). MR-150: CEIL до целых. */}
            <span className="font-display text-2xl font-bold text-fg">{period === 'year' ? Math.round(due.sum * 12 * (1 - annualDiscount)) : due.sum} {cur}</span>
            <span className="text-sm text-muted">{added.length ? 'к оплате' : 'ничего не добавлено'}</span>
            {added.length > 0 && period === 'year' && <span className="rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">−{Math.round(annualDiscount * 100)}%</span>}
            {added.length > 0 && period === 'month' && due.discount > 0 && <span className="text-sm text-muted line-through">{due.full} {cur}</span>}
          </div>
          {/* MR-150: сколько ⚡ приходит КАЖДЫЙ месяц по подписке. Считаем по ВСЕЙ подписке
              (оплаченные + добавленные), а не по добавленным: заказчик просил видеть общее
              число (пример с созвона — 14 модулей = 1400 ⚡/мес). Иначе у того, у кого всё
              оплачено, строка пропадала: оплаченные модули не входят в «добавленные». */}
          {cost.monthlyTokens > 0 && (
            // Значок ⚡ здесь ТОЛЬКО текстовый: иконка Zap рядом давала вторую молнию
            // в одной строке. На плитках модулей ровно так же — одним символом.
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
              <span>
                <b className="text-fg">{cost.monthlyTokens.toLocaleString('ru-RU')}</b> ⚡ токенов в месяц по подписке
              </span>
              {added.length > 0 && due.monthlyTokens > 0 && (
                <span className="text-spark-300">+{due.monthlyTokens.toLocaleString('ru-RU')} ⚡ за добавленные</span>
              )}
            </div>
          )}
          {/* MR-150: подарочные токены — отдельной жёлтой строкой, а не в общей серой.
              Считаем по ВСЕЙ подписке, как и месячные: по добавленным строка пропадала
              у того, у кого всё оплачено, — а подарок он получил и должен его видеть.
              Когда модули добавляют, рядом отдельно показываем подарок за них. */}
          {cost.giftTokens > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs font-semibold text-amber-300">
              <span>+{cost.giftTokens.toLocaleString('ru-RU')} ⚡ токенов в подарок</span>
              {added.length > 0 && due.giftTokens > 0 && (
                <span className="text-amber-200/80">из них +{due.giftTokens.toLocaleString('ru-RU')} ⚡ за добавленные</span>
              )}
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
          title={changed ? 'Спишется с баланса $ за добавленные модули' : 'Новых модулей не выбрано'}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {`Оплатить на ${period === 'year' ? 'год' : 'месяц'}`}
        </button>
      </div>

      <p className="text-xs text-muted">
        Списывается с баланса $ и только за <b className="text-fg">добавленные</b> модули — повторно за то,
        что уже оплачено, платить не нужно. Оплаченные модули <b className="text-fg">нельзя снять</b>: они
        действуют до конца оплаченного периода, и досрочное отключение денег не вернёт. Когда срок подписки
        истекает, модуль перестаёт запускаться, пока её не продлят. Модули, которых нет в подписке, не
        показываются в меню и не запускаются. Права ролей действуют отдельно: сотрудник видит только то,
        что и оплачено, и разрешено ему администратором.
      </p>

      {/* MR-158: «История операций» перенесена сюда из профиля — это раздел про деньги/подписку. */}
      <WalletHistory />
    </div>
  )
}
