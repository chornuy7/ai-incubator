import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import {
  Menu, Zap, Sun, Moon, Radar, ChevronDown, UserCog, LogOut, Wallet, Check,
} from 'lucide-react'
import { useApp, activeAccounts } from '@/mocks/store'
import { useUi } from '@/shared/lib/uiStore'
import { coins as fmtCoins } from '@/shared/lib/utils'
import { Dropdown, MenuItem, Modal, Avatar } from '@/shared/ui'
import { LANGUAGES } from '@/shared/config/modules'

const COIN_PACKS = [
  { coins: 50, price: '4.99 $' },
  { coins: 200, price: '17.99 $', best: true },
  { coins: 500, price: '39.99 $' },
]

export function AppHeader() {
  const nav = useNavigate()
  const data = useApp((s) => s.data)
  const theme = useApp((s) => s.theme)
  const toggleTheme = useApp((s) => s.toggleTheme)
  const locale = useApp((s) => s.locale)
  const setLocale = useApp((s) => s.setLocale)
  const setMobileNav = useApp((s) => s.setMobileNav)
  const setUserState = useApp((s) => s.setUserState)
  const pushToast = useApp((s) => s.pushToast)
  const coinsOpen = useUi((s) => s.coinsOpen)
  const setCoinsOpen = useUi((s) => s.setCoinsOpen)
  const [langOpenTick, setLangOpenTick] = useState(0)

  const active = activeAccounts(data).length
  const limit = data.plan.accountLimit
  const currentLang = LANGUAGES.find((l) => l.code === locale) ?? LANGUAGES[1]

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-2 px-4 sm:px-6 lg:px-8">
        <button onClick={() => setMobileNav(true)} className="btn-icon lg:hidden" aria-label="Меню">
          <Menu size={18} />
        </button>

        {/* Plan badge */}
        <div className="hidden items-center gap-2 rounded-xl border border-line bg-elevated px-3 py-1.5 sm:flex">
          <span className="text-xs font-medium text-muted">План</span>
          <span className="text-sm font-bold text-fg">{data.plan.name}</span>
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
          <button
            onClick={() => setCoinsOpen(true)}
            className="flex items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 transition-colors hover:bg-amber-500/15"
          >
            <Zap size={16} className="text-amber-400" fill="currentColor" />
            <span className="text-sm font-bold text-amber-300">{fmtCoins(data.coins)}</span>
          </button>

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
                <Avatar name={data.user.nick} color="#7145ff" size={30} />
                <span className="hidden text-sm font-semibold text-fg sm:inline">{data.workspace}</span>
                <ChevronDown size={14} className="hidden text-muted sm:inline" />
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="border-b border-line px-3 py-2.5">
                  <div className="text-sm font-bold text-fg">{data.user.firstName} {data.user.lastName}</div>
                  <div className="text-xs text-muted">{data.user.email}</div>
                </div>
                <div className="py-1">
                  <MenuItem icon={<UserCog size={16} />} onClick={() => { nav('/panel/user/profile'); close() }}>Мой аккаунт</MenuItem>
                  <MenuItem icon={<Wallet size={16} />} onClick={() => { setCoinsOpen(true); close() }}>Пополнить монеты</MenuItem>
                  <MenuItem icon={<LogOut size={16} />} tone="danger" onClick={() => { setUserState('guest'); nav('/') }}>Выйти</MenuItem>
                </div>
              </>
            )}
          </Dropdown>
        </div>
      </div>

      {/* Coins modal */}
      <Modal
        open={coinsOpen}
        onClose={() => setCoinsOpen(false)}
        title="Баланс монет"
        subtitle="Монеты ⚡ тратятся на запуск модулей и проверки GGR"
        icon={<Zap size={22} fill="currentColor" />}
        size="md"
      >
        <div className="mb-4 flex items-center justify-between rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3.5">
          <span className="text-sm font-medium text-muted">Текущий баланс</span>
          <span className="flex items-center gap-1.5 font-display text-2xl font-bold text-amber-300">
            <Zap size={20} fill="currentColor" /> {fmtCoins(data.coins)}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {COIN_PACKS.map((p) => (
            <button
              key={p.coins}
              onClick={() => { pushToast({ type: 'info', title: 'Оплата в демо отключена', desc: `Пакет ${p.coins} ⚡ — только визуал.` }); setCoinsOpen(false) }}
              className={`relative flex flex-col items-center gap-1 rounded-2xl border p-4 transition-all hover:-translate-y-0.5 ${p.best ? 'border-spark-500/50 bg-spark-500/8' : 'border-line bg-elevated'}`}
            >
              {p.best && <span className="absolute -top-2 rounded-full bg-spark-gradient px-2 py-0.5 text-[10px] font-bold text-[#04150c]">ВЫГОДНО</span>}
              <Zap size={22} className="text-amber-400" fill="currentColor" />
              <span className="font-display text-xl font-bold text-fg">{p.coins}</span>
              <span className="text-sm font-semibold text-muted">{p.price}</span>
            </button>
          ))}
        </div>
      </Modal>
    </header>
  )
}
