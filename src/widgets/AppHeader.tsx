import { useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import {
  Menu, Zap, Sun, Moon, Radar, ChevronDown, UserCog, LogOut, Wallet, Check, AlertTriangle, Package,
} from 'lucide-react'
import { useApp, activeAccounts } from '@/mocks/store'
import { fetchBalance, fetchPricing, buyTokens, type Balance, type Pricing } from '@/api/balanceApi'
import { useSession } from '@/features/auth/session'
import { usePlan } from '@/features/billing/plan'
import { CRITICAL } from '@/features/billing/LowBalanceBar'
import { useUi } from '@/shared/lib/uiStore'
import { coins as fmtCoins } from '@/shared/lib/utils'
import { confirmDialog } from '@/shared/lib/dialog'
import { Dropdown, MenuItem, Modal, Avatar } from '@/shared/ui'
import { LANGUAGES, moduleTitle } from '@/shared/config/modules'

/**
 * Запасные пакеты — на случай, если прайс с сервера не приехал. Настоящие цены
 * живут в server/pricing.js: курс монеты определяет реальную выручку с действия,
 * и копия в вебе неизбежно разъедется с прайсом и счётом.
 */
const FALLBACK_PACKS = [
  { coins: 50, price: 4.99 },
  { coins: 200, price: 17.99, best: true },
  { coins: 500, price: 39.99 },
]

export function AppHeader() {
  const nav = useNavigate()
  const data = useApp((s) => s.data)
  // B2 (§5.1): план и монеты — с сервера, а не константа из моков. Раньше в шапке
  // всегда висели «Базовая» и 80.00 независимо от того, что происходило в системе.
  // Обновляем периодически: списания за действия (C2) идут в фоне, и цифра должна
  // меняться без перезагрузки страницы.
  const [balance, setBalance] = useState<Balance | null>(null)
  useEffect(() => {
    const load = () => { void fetchBalance().then(setBalance).catch(() => {}) }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])
  // Прайс — с сервера: копия в вебе рано или поздно разошлась бы с тем, что списывается.
  const [pricing, setPricing] = useState<Pricing | null>(null)
  useEffect(() => { void fetchPricing().then(setPricing).catch(() => {}) }, [])
  const theme = useApp((s) => s.theme)
  const toggleTheme = useApp((s) => s.toggleTheme)
  const locale = useApp((s) => s.locale)
  const setLocale = useApp((s) => s.setLocale)
  const setMobileNav = useApp((s) => s.setMobileNav)
  const setUserState = useApp((s) => s.setUserState)
  const pushToast = useApp((s) => s.pushToast)
  const sessionUser = useSession((s) => s.user)
  const logout = useSession((s) => s.logout)
  // Права перечитываем с сервера: выданный или отозванный админом доступ должен
  // применяться в текущей сессии, а не «после перезахода» — про перезаход человеку
  // никто не скажет, а отзыв доступа, ждущий перелогина, это уже дыра.
  const refreshSession = useSession((s) => s.refresh)
  // Подписку тянем тем же тиком: оплатили модуль — он появляется в меню сам,
  // как и выданное админом право.
  const loadPlan = usePlan((s) => s.load)
  useEffect(() => {
    void refreshSession(); void loadPlan()
    const t = setInterval(() => { void refreshSession(); void loadPlan() }, 30000)
    return () => clearInterval(t)
  }, [refreshSession, loadPlan])
  const coinsOpen = useUi((s) => s.coinsOpen)
  const setCoinsOpen = useUi((s) => s.setCoinsOpen)
  const noCoins = useUi((s) => s.noCoins)
  const setNoCoins = useUi((s) => s.setNoCoins)
  const noSubscription = useUi((s) => s.noSubscription)
  const setNoSubscription = useUi((s) => s.setNoSubscription)
  const [langOpenTick, setLangOpenTick] = useState(0)

  const active = activeAccounts(data).length
  const limit = balance?.plan.accountLimit ?? data.plan.accountLimit
  const currentLang = LANGUAGES.find((l) => l.code === locale) ?? LANGUAGES[1]

  // R1/R2: шапка отражает залогиненного пользователя сессии (а не мок-профиль), + его роль.
  const displayName = sessionUser?.name || data.workspace
  const fullName = sessionUser?.name || `${data.user.firstName} ${data.user.lastName}`
  const email = sessionUser?.email || data.user.email
  const roleLabel = sessionUser ? (sessionUser.isAdmin ? 'Администратор' : (sessionUser.roleName || 'Роль не задана')) : null
  const doLogout = () => { logout(); setUserState('guest'); nav('/') }

  // §11.4: $ — основной кошелёк. Купить токены = потратить деньги со счёта (buyTokens
  // списывает $ и начисляет ⚡). Пополнение самих $ — через платёжку, которую ещё
  // подключают, поэтому пока показываем честный статус, а не делаем вид, что зачислили.
  const curSym = pricing?.currency || '$'
  const [buying, setBuying] = useState<number | null>(null)
  // Покупка списывает деньги со счёта СРАЗУ — поэтому сначала явное подтверждение
  // (человек жаловался: «нажал — и оно автоматом купило»). Без ok — ничего не списываем.
  const buyPack = async (usd: number, coins: number) => {
    const ok = await confirmDialog({
      title: 'Купить токены',
      message: `Купить ${fmtCoins(coins)} ⚡ за ${curSym}${usd}? Деньги спишутся со счёта сразу.`,
      confirmLabel: `Купить за ${curSym}${usd}`,
    })
    if (!ok) return
    setBuying(usd)
    try {
      const r = await buyTokens(usd)
      setBalance(r.balance)
      pushToast({ type: 'success', title: `Куплено ${fmtCoins(r.tokens)} ⚡`, desc: `Списано ${curSym}${r.spentUsd.toFixed(2)}` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось купить токены', desc: e instanceof Error ? e.message : 'Пополните $ на счёте' })
    } finally { setBuying(null) }
  }
  const TOPUP_USD = [10, 25, 50, 100]
  const [topupDraft, setTopupDraft] = useState('')
  const topUpUsd = (amount: number) => {
    if (!(amount > 0)) { pushToast({ type: 'error', title: 'Укажите сумму больше нуля' }); return }
    pushToast({ type: 'info', title: 'Пополнение $ скоро', desc: `Оплата на ${curSym}${amount} — подключаем платёжную систему (VIVA/Stripe).` })
  }
  const topUpCustom = () => {
    const v = Number(String(topupDraft).replace(',', '.'))
    if (!Number.isFinite(v) || v <= 0) { pushToast({ type: 'error', title: 'Нужна сумма', desc: 'Например 30' }); return }
    topUpUsd(Math.round(v * 100) / 100); setTopupDraft('')
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-2 px-4 sm:px-6 lg:px-8">
        <button onClick={() => setMobileNav(true)} className="btn-icon lg:hidden" aria-label="Меню">
          <Menu size={18} />
        </button>

        {/* Plan badge */}
        <div className="hidden items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-1.5 sm:flex">
          <span className="text-xs font-medium text-muted">План</span>
          <span className="text-sm font-bold text-fg">{balance?.plan.name ?? data.plan.name}</span>
        </div>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {/* Парсинг данных CTA */}
          <button onClick={() => nav('/panel/modules/parsing')} className="btn-iris hidden h-9 px-3.5 md:inline-flex">
            <Radar size={16} /> Парсинг данных
          </button>

          {/* Accounts limit */}
          <div className="flex items-center gap-1.5 rounded-xl border border-line bg-elevated px-3 py-1.5">
            <span className="text-sm font-bold text-fg">{active} / {limit}</span>
            <span className="hidden text-xs text-muted sm:inline">акк.</span>
          </div>

          {/* Coins */}
          {/* §11.5: на нуле/почти нуле чип КРАСНЫЙ и со словом «Пополнить» — по звонку
              29.07 это критическое уведомление, оно должно тревожить, а не выглядеть
              спокойно-зелёным. Пороги — общие с лентой (LowBalanceBar). */}
          {/* §11.4: деньги и токены — РАЗДЕЛЬНО. По звонку 29.07 владельцу нужен
              отдельно долларовый баланс («баланс всегда в долларах») и отдельно
              количество токенов; «токены в долларах» одним числом — бесполезно.
              Курс монеты берём из пакетов пополнения (та же формула, что на сервере). */}
          {(() => {
            const c = balance?.coins ?? data.coins
            // §11.4: деньги — ОТДЕЛЬНЫЙ остаток с сервера, а не пересчёт токенов по
            // курсу. Владелец: «баланс — это $, за них покупаем подписки и токены».
            // Пока миграция usd-кошелька не применена, поле не приходит — тогда
            // показываем только токены, а не выдуманный ноль долларов.
            const usd = typeof balance?.usd === 'number' ? balance.usd : null
            const tokensLow = c <= CRITICAL
            const usdLow = usd != null && usd <= 0     // §11.5: $0 — тоже тревога (красным)
            const alarm = tokensLow || usdLow          // чип красный, если пусто хоть одно
            const cur = pricing?.currency || '$'
            return (
              <button
                onClick={() => setCoinsOpen(true)}
                title={usdLow && tokensLow ? 'Деньги и токены на нуле — пополнить'
                  : usdLow ? 'Денег на счёте нет — пополнить'
                    : tokensLow ? 'Токены на нуле — пополнить' : 'Деньги и токены'}
                className={
                  'flex items-center gap-2 rounded-xl border px-3 py-1.5 transition-colors ' +
                  (alarm
                    ? 'border-red-500/50 bg-red-500/15 hover:bg-red-500/25'
                    : 'border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/15')
                }
              >
                {usd != null && (
                  <span className={'text-sm font-bold tabular-nums ' + (usdLow ? 'text-red-300' : 'text-fg')}>
                    {cur}{usd.toFixed(2)}
                  </span>
                )}
                <span className={'flex items-center gap-1 ' + (usd != null ? 'border-l border-white/10 pl-2' : '')}>
                  <Zap size={15} className={tokensLow ? 'text-red-400' : 'text-amber-400'} fill="currentColor" />
                  <span className={'text-sm font-bold tabular-nums ' + (tokensLow ? 'text-red-300' : 'text-amber-300')}>{fmtCoins(c)}</span>
                </span>
                {alarm && <span className="text-xs font-bold text-red-300">Пополнить</span>}
              </button>
            )
          })()}

          {/* Theme */}
          <button onClick={toggleTheme} className="btn-icon" aria-label="Тема">
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>

          {/* Language */}
          <Dropdown
            width={180}
            trigger={({ toggle }) => (
              <button onClick={() => { toggle(); setLangOpenTick((t) => t + 1) }} className="btn-icon w-auto gap-1 px-2.5">
                <span className="text-sm font-bold uppercase">{currentLang.code === 'ru' ? 'RU' : currentLang.code === 'ua' ? 'UA' : 'EN'}</span>
                <ChevronDown size={14} />
              </button>
            )}
          >
            {(close) => (
              <div key={langOpenTick}>
                {LANGUAGES.map((l) => (
                  <MenuItem
                    key={l.code}
                    onClick={() => {
                      setLocale(l.code as 'ru' | 'en' | 'ua')
                      close()
                      if (l.code !== 'ru') pushToast({ type: 'info', title: 'Интерфейс доступен только на русском', desc: 'Другие языки появятся позже.' })
                    }}
                    icon={<span className="text-base">{l.flag}</span>}
                  >
                    <span className="flex-1">{l.label}</span>
                    {locale === l.code && <Check size={15} className="text-spark-400" />}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>

          {/* User menu */}
          <Dropdown
            width={240}
            trigger={({ toggle }) => (
              <button onClick={toggle} className="flex items-center gap-2 rounded-xl border border-line bg-elevated py-1 pl-1 pr-2 transition-colors hover:border-spark-500/30">
                <Avatar name={displayName} color="#7145ff" size={30} />
                <span className="hidden text-sm font-semibold text-fg sm:inline">{displayName}</span>
                <ChevronDown size={14} className="hidden text-muted sm:inline" />
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="border-b border-line px-3 py-2.5">
                  <div className="text-sm font-bold text-fg">{fullName}</div>
                  <div className="text-xs text-muted">{email}</div>
                  {roleLabel && (
                    <span className={`mt-1.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold ${sessionUser?.isAdmin ? 'bg-iris-500/15 text-iris-300' : 'bg-spark-500/15 text-spark-300'}`}>
                      {sessionUser?.isAdmin ? 'Администратор' : `Роль: ${roleLabel}`}
                    </span>
                  )}
                </div>
                <div className="py-1">
                  <MenuItem icon={<UserCog size={16} />} onClick={() => { nav('/panel/user/profile'); close() }}>Мой аккаунт</MenuItem>
                  <MenuItem icon={<Wallet size={16} />} onClick={() => { setCoinsOpen(true); close() }}>Пополнить токены</MenuItem>
                  <MenuItem icon={<LogOut size={16} />} tone="danger" onClick={() => { doLogout(); close() }}>Выйти</MenuItem>
                </div>
              </>
            )}
          </Dropdown>
        </div>
      </div>

      {/*
        Нулевой баланс: окно по центру вместо тоста в углу. Запуск не состоялся —
        значит человеку нужно не уведомление, а следующий шаг, и кнопка ведёт
        прямо в пополнение, а не оставляет искать его в меню.
      */}
      <Modal
        open={!!noCoins}
        onClose={() => setNoCoins('')}
        title="Недостаточно монет"
        subtitle="Модули остановлены"
        icon={<AlertTriangle size={22} />}
        size="sm"
        footer={(
          <>
            <button onClick={() => setNoCoins('')} className="btn-ghost">Закрыть</button>
            {/* §11.5: «Пополнить» — красным, а не зелёным btn-primary: это тревожное
                уведомление, а не радостное действие. */}
            <button
              onClick={() => { setNoCoins(''); setCoinsOpen(true) }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-red-500 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-400"
            >
              <Zap size={16} fill="currentColor" /> Пополнить баланс
            </button>
          </>
        )}
      >
        <p className="text-sm leading-relaxed text-muted">{noCoins}</p>
        <div className="mt-4 flex items-center justify-between rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <span className="text-sm font-medium text-muted">Текущий баланс</span>
          <span className="flex items-center gap-1.5 font-display text-xl font-bold text-amber-300">
            <Zap size={18} fill="currentColor" /> {fmtCoins(balance?.coins ?? 0)}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted">
          Платные все модули, включая сбор данных. Цены по действиям — в окне «Пополнить баланс».
        </p>
      </Modal>

      {/* Модуль не оплачен — это не про монеты, и путь отсюда в кабинет. */}
      <Modal
        open={!!noSubscription}
        onClose={() => setNoSubscription('')}
        title="Модуль не оплачен"
        subtitle="Его нет в вашей подписке"
        icon={<Package size={22} />}
        size="sm"
        footer={(
          <>
            <button onClick={() => setNoSubscription('')} className="btn-ghost">Закрыть</button>
            <button
              onClick={() => { setNoSubscription(''); nav('/panel/user/subscription') }}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              <Package size={16} /> Мои модули
            </button>
          </>
        )}
      >
        <p className="text-sm leading-relaxed text-muted">{noSubscription}</p>
        <p className="mt-3 text-xs text-muted">
          Подписка и монеты — разные вещи: монеты тратятся на действия внутри модуля,
          подписка открывает сам модуль. Менять набор может владелец рабочего пространства.
        </p>
      </Modal>

      {/* Coins modal */}
      <Modal
        open={coinsOpen}
        onClose={() => setCoinsOpen(false)}
        title="Кошелёк"
        subtitle="Деньги, токены и подключённые модули"
        icon={<Wallet size={22} />}
        size="md"
      >
        {/* §11.4: ДЕНЬГИ ($) — основное, крупно и первым; токены ⚡ — вторично.
            Разделение со звонка: «баланс — это $, за них покупаем подписки и токены». */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-spark-500/40 bg-spark-500/8 px-4 py-3.5">
            <div className="text-xs font-medium text-muted">Деньги на счету</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-display text-2xl font-bold text-spark-200">
              {curSym}{(balance?.usd ?? 0).toFixed(2)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted">за них — подписки и токены</div>
          </div>
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3.5">
            <div className="text-xs font-medium text-muted">Токены (топливо)</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-display text-2xl font-bold text-amber-300">
              <Zap size={20} fill="currentColor" /> {fmtCoins(balance?.coins ?? data.coins)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted">тратятся за каждое действие</div>
          </div>
        </div>

        {/* §11.4: в кошельке лежит всё, что человек взял за $ — не только деньги и токены,
            но и открытые модули (подписка). Держим это в одном месте, а не по разным экранам. */}
        <div className="mb-4 rounded-2xl border border-line bg-elevated/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">Мои модули</span>
            <button onClick={() => { setCoinsOpen(false); nav('/panel/user/subscription') }} className="text-xs text-spark-300 hover:text-spark-200">Изменить →</button>
          </div>
          {(() => {
            const mods = balance?.modules
            if (mods === 'all' || mods == null) return <div className="text-sm text-muted">Открыты <b className="text-fg">все модули</b> (набор не выбран).</div>
            if (!mods.length) return <div className="text-sm text-muted">Модули не подключены — оформите подписку за {curSym}.</div>
            return (
              <div className="flex flex-wrap gap-1.5">
                {mods.map((k) => (
                  <span key={k} className="rounded-lg border border-spark-500/30 bg-spark-500/8 px-2 py-1 text-xs text-spark-200">{moduleTitle(k)}</span>
                ))}
              </div>
            )
          })()}
        </div>

        {/* Пополнить $ — основная валюта. Оплата подключается (VIVA/Stripe), пока — честный статус. */}
        <div className="mb-4 rounded-2xl border border-line bg-elevated/50 p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Пополнить счёт ({curSym})</div>
          <div className="grid grid-cols-4 gap-2">
            {TOPUP_USD.map((a) => (
              <button
                key={a}
                onClick={() => topUpUsd(a)}
                className="flex flex-col items-center gap-0.5 rounded-xl border border-line bg-card py-2.5 transition-colors hover:border-spark-500/40 hover:text-spark-200"
              >
                <span className="font-display text-lg font-bold text-fg">{curSym}{a}</span>
              </button>
            ))}
          </div>
          {/* Своя сумма — не только пресеты: человек вводит сколько хочет. */}
          <div className="mt-2 flex items-center gap-2">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">{curSym}</span>
              <input
                value={topupDraft}
                onChange={(e) => setTopupDraft(e.target.value.replace(/[^\d.,]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') topUpCustom() }}
                inputMode="decimal"
                placeholder="своя сумма"
                className="input h-9 w-full pl-7 text-sm"
              />
            </div>
            <button onClick={topUpCustom} className="btn-ghost h-9 rounded-xl border border-line px-3 text-sm hover:border-spark-500/40 hover:text-spark-200">Пополнить</button>
          </div>
        </div>

        {/* Обменять деньги на токены: списываем $ со счёта и начисляем ⚡ (buyTokens). */}
        <div className="mb-4 rounded-2xl border border-line bg-elevated/50 p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Купить токены за {curSym} со счёта</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(pricing?.packs?.length ? pricing.packs : FALLBACK_PACKS).map((p) => (
              <button
                key={p.coins}
                onClick={() => void buyPack(p.price, p.coins)}
                disabled={buying !== null}
                className={`relative flex flex-col items-center gap-1 rounded-2xl border p-4 transition-all hover:-translate-y-0.5 disabled:opacity-50 ${p.best ? 'border-spark-500/50 bg-spark-500/8' : 'border-line bg-elevated'}`}
              >
                {p.best && <span className="absolute -top-2 rounded-full bg-spark-gradient px-2 py-0.5 text-[10px] font-bold text-[#04150c]">ВЫГОДНО</span>}
                <Zap size={22} className="text-amber-400" fill="currentColor" />
                <span className="font-display text-xl font-bold text-fg">{p.coins}</span>
                <span className="text-sm font-semibold text-muted">{p.price} {curSym}</span>
                {/* Цена монеты в пакете: «выгодно» должно быть посчитано, а не заявлено. */}
                <span className="text-[10px] text-faint">{(p.price / p.coins).toFixed(3)} {curSym} / ⚡</span>
              </button>
            ))}
          </div>
        </div>

        {/* Прайс: человек должен видеть, за что уходят токены, до покупки, а не после. */}
        {pricing && (
          <div className="rounded-2xl border border-line bg-elevated/50 p-3">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Сколько стоит действие</div>
            <div className="max-h-40 overflow-y-auto pr-1">
              {pricing.items.map((p) => (
                <div key={p.key} className="flex items-center justify-between border-b border-line/50 py-1 text-sm last:border-0">
                  <span className="text-muted">{p.title}</span>
                  <span className="font-semibold tabular-nums text-fg">{p.price} ⚡</span>
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted">
              Плюс расход ИИ по факту: {pricing.coinsPer1kTokens} ⚡ за 1000 токенов.
            </div>
          </div>
        )}
      </Modal>
    </header>
  )
}
