import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Check, Package, Sparkles, Loader2, Lock, CalendarClock, AlertTriangle, ExternalLink, XCircle, ChevronDown } from 'lucide-react'
import { PageHeader, Card, Tip, Modal } from '@/shared/ui'
import { FloatingBar } from '@/features/modules/shared/FloatingBar'
import { useApp } from '@/mocks/store'
import { usePlan } from '@/features/billing/plan'
import { useBalance } from '@/features/billing/balanceStore'
import { expiryInfo, daysLeftPhrase } from '@/features/billing/expiry'
import { fetchSubscription, saveSubscription, cancelSubscription, type Subscription } from '@/api/balanceApi'
import { cn } from '@/shared/lib/utils'
import { moduleTitle } from '@/shared/config/modules'
import { WalletHistoryButton } from '@/pages/ProfilePage'

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
/** «1 модуль · 2 модуля · 5 модулей» — иначе в шапке подписки читается как машинный вывод. */
const склонение = (n: number): string => {
  const д = n % 10, с = n % 100
  if (д === 1 && с !== 11) return 'модуль'
  if (д >= 2 && д <= 4 && (с < 12 || с > 14)) return 'модуля'
  return 'модулей'
}

export function SubscriptionPage() {
  const pushToast = useApp((s) => s.pushToast)
  const loadPlan = usePlan((s) => s.load)
  const [data, setData] = useState<Subscription | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  // MR-228: отмена подписки — одно подтверждение, как просил заказчик («Вы уверены?»).
  const [отменаОткрыта, setОтменаОткрыта] = useState(false)
  const [отменяю, setОтменяю] = useState(false)
  const [составВиден, setСоставВиден] = useState(false)
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
  /*
   * Цена докупки — РАЗНИЦА: сколько подписка стала стоить в месяц минус сколько стоила.
   * Так же считает сервер (`addedCost`), и иначе витрина обещала бы не ту цену, которую
   * спишет: скидка набора при докупке пропадала, и клиент, добравший пятый модуль
   * «Аутрича», платил за него полную цену, хотя именно ею набор и закрывал.
   * Токены (месячные и подарочные) остаются ПО ДОБАВЛЕННЫМ — их начисляют за них.
   */
  const paidNow = useMemo(() => priceOf(mineSet), [priceOf, mineSet])
  const dueSum = Math.max(0, cost.sum - paidNow.sum)
  const dueFull = Math.max(0, cost.full - paidNow.full)

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
  /*
   * MR-229: какой из готовых наборов человек уже купил.
   *
   * Заказчик 30.08: «Мне надо, чтобы я просто понял, что это моя текущая подписка. Все
   * остальные ты должен затемнить, они должны быть ненажимаемые».
   *
   * Сверяем ПО СОСТАВУ, а не по тому, что нажали при покупке: подписка живёт дальше своей
   * жизнью — модуль могли докупить, и тогда набор перестаёт быть тем самым. Тот же приём,
   * что и в подписи операций (MR-230): состав виден всегда, а намерение — нет.
   */
  const отпечаток = (ks: string[]) => [...new Set(ks)].sort().join(' ')
  const мой = useMemo(() => отпечаток([...mineSet].map(String)), [mineSet])
  const текущийНабор = useMemo(
    () => (мой ? (data?.setups || []).find((s) => отпечаток(s.modules) === мой)?.id ?? null : null),
    [мой, data],
  )

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
        // MR-157: история операций — кнопкой в шапке, а не блоком внизу страницы: там её
        // перекрывала нижняя панель оплаты, и до неё приходилось листать весь список модулей.
        actions={<WalletHistoryButton />}
      />

      {/* §5 (21.08): срок подписки на виду. Раньше кабинет показывал только состав
          набора, и «до какого числа оплачено» человек не мог узнать нигде, кроме
          профиля. Три состояния: истекла (красное), кончается на неделе (жёлтое,
          с призывом продлить), обычное. Бессрочная так и подписана словом — пустая
          строка читалась бы как «данных нет». */}
      {expKnown && mineSet.size > 0 && (() => {
        const отменена = !!balance?.canceledAt
        const состав = [...mineSet].map((k) => moduleTitle(String(k)))
        const имя = balance?.setName || (состав.length ? `${состав.length} ${склонение(состав.length)}` : '')
        return (
          <Card className={cn(
            'p-4',
            exp.expired ? 'border-red-500/40' : отменена ? 'border-amber-500/40' : exp.soon ? 'border-amber-500/40' : '',
          )}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {exp.expired || exp.soon || отменена
                ? <AlertTriangle size={16} className={exp.expired ? 'text-red-300' : 'text-amber-300'} />
                : <CalendarClock size={16} className="text-muted" />}
              {/* ЧТО оплачено — первым: «какая подписка» человек спрашивает раньше, чем «до когда». */}
              {имя && <span className="font-semibold text-fg">Подписка «{имя}»</span>}
              <span className={cn(
                'font-semibold',
                exp.expired ? 'text-red-300' : отменена ? 'text-amber-300' : exp.soon ? 'text-amber-300' : 'text-fg',
              )}>
                {exp.perpetual
                  ? 'Подписка бессрочная'
                  : exp.expired
                    ? `Подписка истекла ${exp.date}`
                    : отменена
                      ? `отменена · доступ до ${exp.date}`
                      : `оплачено до ${exp.date}`}
              </span>
              <span className="text-sm text-muted">
                {exp.perpetual
                  ? '· срок не ограничен — продлевать не нужно'
                  : exp.expired
                    ? '· модули не запускаются, пока подписку не продлят'
                    : отменена
                      ? `· осталось ${daysLeftPhrase(exp.daysLeft)}, дальше списаний не будет`
                      : `· осталось ${daysLeftPhrase(exp.daysLeft)}${exp.soon ? ' — продлите, чтобы модули не остановились' : ''}`}
              </span>

              {/* Красная СРАЗУ, а не по наведению (заказчик 31.08): разрушающее действие
                  должно читаться как разрушающее до того, как на него навели мышь. Тот же
                  приём, что у «Закрыть» в тикетах и «Удалить» в автопостинге. */}
              {!exp.perpetual && !exp.expired && !отменена && (
                <button
                  onClick={() => setОтменаОткрыта(true)}
                  className="btn-ghost ml-auto h-8 shrink-0 text-xs text-rose-300 hover:bg-rose-500/10"
                >
                  <XCircle size={14} /> Отменить подписку
                </button>
              )}
            </div>

            {/* «Что в неё входит» — списком по клику: четырнадцать названий в строку не влезают. */}
            {состав.length > 0 && (
              <div className="mt-2">
                <button
                  onClick={() => setСоставВиден((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-fg"
                >
                  <ChevronDown size={13} className={cn('transition-transform', составВиден && 'rotate-180')} />
                  {составВиден ? 'скрыть состав' : `что входит · ${состав.length} ${склонение(состав.length)}`}
                </button>
                {составВиден && (
                  <div className="mt-1.5 text-xs leading-relaxed text-muted">{состав.join(', ')}</div>
                )}
              </div>
            )}
          </Card>
        )
      })()}

      <Card>
        <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">Готовые наборы</div>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {data.setups.map((s) => {
            const текущий = текущийНабор === s.id
            // Затемняем остальные ТОЛЬКО когда текущий набор вообще определён: у человека
            // со своим сочетанием модулей «текущего» набора нет, и гасить витрину не за что.
            const заблокирован = !!текущийНабор && !текущий
            return (
            <button
              key={s.id}
              disabled={заблокирован}
              onClick={() => applySetup(s.modules)}
              title={заблокирован ? 'Это не ваша подписка — сначала отмените или измените текущую' : undefined}
              className={cn(
                'rounded-2xl border p-4 text-left transition-all',
                заблокирован
                  ? 'cursor-not-allowed border-line/60 bg-elevated/40 opacity-40'
                  : 'hover:-translate-y-0.5',
                текущий
                  ? 'border-emerald-500/60 bg-emerald-500/10'
                  : cost.setup === s.id ? 'border-spark-500/50 bg-spark-500/8' : 'border-line bg-elevated',
              )}
            >
              <div className="flex items-center gap-1.5 font-display text-base font-bold text-fg">
                <Sparkles size={15} className="text-spark-400" /> {s.name}
                {s.custom && <span className="rounded-md bg-iris-500/15 px-1.5 py-0.5 text-[10px] font-bold text-iris-300">набор</span>}
                {текущий && (
                  <span className="rounded-md bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">Текущая подписка</span>
                )}
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
                    {/* MR-189: подарок — РАЗОВЫЙ, и это должно быть написано. «200 ⚡ в месяц ·
                        +200 ⚡ в подарок» читалось как удвоение месячной выдачи (созвон 24.08:
                        «странно звучит 200 вместе с 200… и так понятно, что 200 в месяц»). */}
                    {mo ? <span className="text-fg/70">{mo.toLocaleString('ru-RU')} ⚡ в месяц</span> : null}
                    {mo && gift ? <span className="text-faint"> · </span> : null}
                    {gift ? <span className="text-amber-300">разово при покупке +{gift.toLocaleString('ru-RU')} ⚡</span> : null}
                  </div>
                )
              })()}
            </button>
            )
          })}
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
              <Tip
                className="min-w-0 flex-1"
                text={paid
                  ? `Модуль оплачен${!expKnown ? '' : exp.perpetual ? ' бессрочно' : exp.expired ? ` до ${exp.date} — оплата закончилась` : ` до ${exp.date}`} — снять его в кабинете нельзя`
                  : undefined}
              >
              <button
                type="button"
                onClick={() => toggle(m.key)}
                disabled={paid}
                className={cn('flex w-full min-w-0 items-center justify-between gap-3 text-left', paid && 'cursor-default')}
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
                        {m.gift ? <span className="text-amber-300">разово +{m.gift} ⚡</span> : null}
                      </span>
                    ) : null}
                  </span>
                </span>
                {/* §11.2 (31.07): в кабинете цена — только текстом. Правка цен — в админ-панели. */}
                <span className="shrink-0 font-semibold tabular-nums text-fg">{m.price} {cur}</span>
              </button>
              </Tip>
                {/*
                  «Подробнее о модуле» — на страницу модуля лендинга, в НОВОЙ вкладке
                  (просьба владельца 21.08). Человек читает описание, не потеряв набранную
                  корзину: возврат по крестику вкладки, а не «назад» с перезагрузкой выбора.
                  Отдельные парсеры своей страницы не имеют — у них одна общая, «Парсинг».
                  Ссылка вынесена ИЗ кнопки выбора: ссылка внутри кнопки — невалидная
                  разметка, и клик по ней заодно переключал бы галочку.
                */}
                <Tip className="shrink-0" text="Подробнее о модуле — откроется в новой вкладке">
                  <a
                    href={`/module/${m.key.startsWith('parsing') ? 'parsing' : m.key}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-spark-500/40 hover:text-spark-300"
                  >
                    Подробнее <ExternalLink size={11} className="shrink-0" />
                  </a>
                </Tip>
              </div>
            )
          })}
        </div>
      </Card>

      {/* Итог держим на виду: сумма меняется от каждого клика, и уезжать за ней вниз незачем. */}
      {/* Созвон 12.08: «переделайте эту нижнюю летающую панельку с ценой в прикреплённую
          фиксированную панель внизу на всю длину». Плавающая панель со скруглением
          перекрывала плитки модулей под собой — было видно обрезанные карточки.
          Берём тот же FloatingBar, что и панель запуска в модулях: край в край рабочей
          области, прижата ко дну, и она сама резервирует под себя место, чтобы низ
          страницы не прятался. */}
      <FloatingBar>
        {/* Раскладка та же, что у панели запуска модулей: слева сводка, по центру
            переключатель периода (растягивается), справа кнопка у правого края.
            Без этого содержимое липло к краям, а между ними зияла дыра. */}
        <div className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2">
          {/* Слева — чипами в ОДНУ строку, как цена и время в панели запуска модулей.
              Раньше это были четыре строки друг под другом, и панель вырастала вдвое выше
              (109 px против 61 у панели запуска). Требование MR-150 сохранено: месячные
              токены и подарок остаются ОТДЕЛЬНО, подарок жёлтым — просто отдельными
              чипами, а не отдельными строками. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* Подсказка — общий <Tip> (тёмная всплывашка порталом), а не нативный `title`
                браузера: заказчик просил единый вид подсказок везде (правка 20.08 + ревью
                MR-188). */}
            <Tip
              // Скидку в подсказке берём от ИТОГОВОГО набора, а не от добавленного куска:
              // именно итоговый набор её и даёт.
              text={`В подписке модулей: ${keys.length}${added.length ? ` · добавлено ${added.length}` : ''}${cost.setup ? ` · набор «${data.setups.find((x) => x.id === cost.setup)?.name}» — скидка ${Math.round(cost.discount * 100)}%` : ''}`}
            >
              <span className="flex h-10 items-center gap-1.5 rounded-xl border border-line bg-elevated px-3.5 text-sm font-bold text-fg">
                {period === 'year' ? Math.round(dueSum * 12 * (1 - annualDiscount)) : dueSum} {cur}
                <span className="font-semibold text-muted">{added.length ? 'к оплате' : 'ничего не добавлено'}</span>
                {added.length > 0 && period === 'year' && <span className="rounded-md bg-spark-500/15 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">−{Math.round(annualDiscount * 100)}%</span>}
                {added.length > 0 && period === 'month' && dueFull > dueSum && <span className="text-xs font-semibold text-muted line-through">{dueFull} {cur}</span>}
              </span>
            </Tip>

            {/* MR-150: сколько ⚡ приходит КАЖДЫЙ месяц по ВСЕЙ подписке (оплаченные +
                добавленные). По одним «добавленным» строка пропадала у того, у кого всё
                оплачено. */}
            {cost.monthlyTokens > 0 && (
              <Tip text={period === 'year'
                ? `${cost.monthlyTokens.toLocaleString('ru-RU')} ⚡ КАЖДЫЙ месяц — ${(cost.monthlyTokens * 12).toLocaleString('ru-RU')} ⚡ за год. Сейчас придёт ${cost.monthlyTokens.toLocaleString('ru-RU')} ⚡ за первый месяц, остальные приходят помесячно.`
                : `${cost.monthlyTokens.toLocaleString('ru-RU')} ⚡ токенов в месяц по подписке${added.length && due.monthlyTokens && cost.monthlyTokens !== due.monthlyTokens ? ` · +${due.monthlyTokens.toLocaleString('ru-RU')} ⚡ за добавленные` : ''}`}>
                <span className="flex h-10 items-center gap-1.5 rounded-xl border border-spark-500/30 bg-spark-500/10 px-3.5 text-sm font-bold text-spark-300">
                  {cost.monthlyTokens.toLocaleString('ru-RU')} ⚡<span className="font-semibold text-spark-300/70">в месяц</span>{period === 'year' && <span className="text-xs font-semibold text-spark-300/70">× 12</span>}
                  {/*
                   * Прибавку показываем ТОЛЬКО когда есть к чему прибавлять.
                   * У человека без подписки «всего» и «за добавленные» — одно и то же число,
                   * и чип превращался в повтор: «100 ⚡ в месяц  +100». Читается как 200.
                   */}
                  {added.length > 0 && due.monthlyTokens > 0 && cost.monthlyTokens !== due.monthlyTokens && (
                    <span className="text-xs">+{due.monthlyTokens.toLocaleString('ru-RU')}</span>
                  )}
                </span>
              </Tip>
            )}

            {/* MR-150: подарок — ОТДЕЛЬНО и жёлтым, как и просили. */}
            {cost.giftTokens > 0 && (
              <Tip text={`+${cost.giftTokens.toLocaleString('ru-RU')} ⚡ подарочных — начисляются ОДИН раз при покупке модуля, не каждый месяц${added.length && due.giftTokens && cost.giftTokens !== due.giftTokens ? ` · из них +${due.giftTokens.toLocaleString('ru-RU')} ⚡ за добавленные` : ''}`}>
                <span className="flex h-10 items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 text-sm font-bold text-amber-300">
                  +{cost.giftTokens.toLocaleString('ru-RU')} ⚡<span className="font-semibold text-amber-300/70">разово при покупке</span>
                </span>
              </Tip>
            )}
          </div>

          {/* Центр: переключатель периода. Растягивается на всё свободное место, сам
              переключатель по центру — как дорожная карта в панели запуска. */}
          <div className="flex min-w-0 flex-1 basis-40 justify-center">
            <div className="flex rounded-xl border border-line bg-elevated p-0.5 text-sm">
              {(['month', 'year'] as const).map((p) => (
                <button key={p} onClick={() => setPeriod(p)} className={cn('h-9 rounded-lg px-3 font-semibold transition-colors', period === p ? 'bg-spark-500/15 text-spark-300' : 'text-muted hover:text-fg')}>
                  {p === 'month' ? 'Месяц' : 'Год'}{p === 'year' && <span className="ml-1 text-[10px] text-spark-400">−{Math.round(annualDiscount * 100)}%</span>}
                </button>
              ))}
            </div>
          </div>
          {/* Право: кнопка у правого края — прижимает justify-between, ml-auto не нужен. */}
          <div className="flex shrink-0 items-center justify-end">
            <Tip text={changed ? 'Спишется с баланса $ за добавленные модули' : 'Новых модулей не выбрано'}>
              <button
                onClick={() => void save()}
                disabled={saving || !changed}
                className="btn-primary h-11 min-w-[190px] disabled:opacity-40"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                {`Оплатить на ${period === 'year' ? 'год' : 'месяц'}`}
              </button>
            </Tip>
          </div>
        </div>
      </FloatingBar>

      <p className="text-xs text-muted">
        Списывается с баланса $ и только за <b className="text-fg">добавленные</b> модули — повторно за то,
        что уже оплачено, платить не нужно. Оплаченные модули <b className="text-fg">нельзя снять</b>: они
        действуют до конца оплаченного периода, и досрочное отключение денег не вернёт. Когда срок подписки
        истекает, модуль перестаёт запускаться, пока её не продлят. Модули, которых нет в подписке, не
        показываются в меню и не запускаются. Права ролей действуют отдельно: сотрудник видит только то,
        что и оплачено, и разрешено ему администратором.
      </p>


      {/*
       * Одно подтверждение, как просил заказчик 30.08: «кнопка отмены... Возвратов нет».
       * Двух ступеней здесь не нужно — отмена не уничтожает данные и обратима повторной
       * оплатой, в отличие от удаления аккаунта.
       */}
      <Modal
        open={отменаОткрыта}
        onClose={() => setОтменаОткрыта(false)}
        size="sm"
        icon={<AlertTriangle size={20} className="text-amber-400" />}
        title="Отменить подписку?"
        footer={
          <div className="flex justify-end gap-2">
            <button onClick={() => setОтменаОткрыта(false)} className="btn-ghost h-9">Оставить</button>
            <button
              disabled={отменяю}
              onClick={async () => {
                setОтменяю(true)
                try {
                  await cancelSubscription()
                  await loadPlan()
                  setОтменаОткрыта(false)
                  pushToast({
                    type: 'success',
                    title: 'Подписка отменена',
                    desc: exp.date ? `Модули работают до ${exp.date}, дальше списаний не будет` : 'Списаний больше не будет',
                  })
                } catch (e) {
                  pushToast({ type: 'error', title: 'Не удалось отменить', desc: e instanceof Error ? e.message : '' })
                } finally { setОтменяю(false) }
              }}
              className="btn-danger h-9"
            >
              {отменяю ? <Loader2 size={16} className="animate-spin" /> : <XCircle size={16} />}
              Отменить подписку
            </button>
          </div>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          Модули продолжат работать <b className="text-fg">до {exp.date}</b> — этот период уже оплачен.
          После него подписка не продлится и деньги списываться перестанут.
          <br /><br />
          <b className="text-fg">Возврата за оплаченный период нет.</b> Передумаете — оплатите подписку
          снова, и продления возобновятся.
        </p>
      </Modal>

    </div>
  )
}
